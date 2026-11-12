import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revisarRespuestaPorReglas } from '@vincular/seguridad-clinica';
import { crearEscenario, pedir, type Escenario } from './escenario.ts';

/**
 * Bucle conversacional SIN modelo disponible (el proveedor apunta a un puerto cerrado). Prueba
 * todo lo que no puede depender del modelo: reglas, protocolo de emergencia, respuestas seguras,
 * falla cerrada del guardián, registros y cifrado.
 */
let e: Escenario;
beforeAll(async () => {
  e = await crearEscenario();
});
afterAll(async () => e?.cerrar());

const abrir = async (token = e.tokens.dispositivo) => (await pedir<{ sesionId: string; modoEmergencia: boolean }>(e.f, 'POST', '/api/conversacion/sesiones', token, {})).datos;
const decir = (sesionId: string, texto: string, token = e.tokens.dispositivo) =>
  pedir<{ respuesta: string; nivel: number; modoEmergencia: boolean; turnoId: string }>(e.f, 'POST', `/api/conversacion/sesiones/${sesionId}/turnos`, token, { texto });

describe('bucle conversacional', () => {
  it('si el proveedor no responde, la persona recibe una respuesta segura y queda registrado', async () => {
    const { sesionId } = await abrir();
    const r = await decir(sesionId, 'Hola, ¿cómo está?');
    expect(r.estado).toBe(200);
    expect(r.datos.nivel).toBe(0);
    expect(r.datos.respuesta).toMatch(/problema para pensar/);
    const t = await e.owner.query(`SELECT origen FROM turno WHERE sesion_id = $1 AND hablante = 'agente'`, [sesionId]);
    expect(t.rows).toEqual([{ origen: 'respuesta_segura' }]);
    const g = await e.owner.query('SELECT etapa, accion FROM intervencion_guardian WHERE sesion_id = $1', [sesionId]);
    expect(g.rows).toEqual([{ etapa: 'proveedor', accion: 'respuesta_segura' }]);
    const u = await e.owner.query(`SELECT tarea, ok FROM uso_modelo WHERE sesion_id = $1 ORDER BY tarea`, [sesionId]);
    expect(u.rows).toEqual(expect.arrayContaining([{ tarea: 'conversacion', ok: false }, { tarea: 'riesgo', ok: false }]));
  });

  it('nivel 3 por reglas: protocolo de emergencia sin esperar al modelo, evento registrado con el fragmento literal', async () => {
    const { sesionId } = await abrir();
    const inicio = Date.now();
    const r = await decir(sesionId, 'Ya no quiero vivir, para qué seguir');
    expect(Date.now() - inicio).toBeLessThan(1500);
    expect(r.datos).toMatchObject({ nivel: 3, modoEmergencia: true });
    expect(r.datos.respuesta).toContain('*4141');
    expect(r.datos.respuesta).toContain('131');
    expect(revisarRespuestaPorReglas(r.datos.respuesta).aprobada).toBe(true);

    const ev = await e.owner.query<{ nivel: number; fuente: string; categorias: string[]; fragmento_cifrado: Buffer; acuse_requerido: boolean; evidencia_turno_ids: string[] }>(
      'SELECT nivel, fuente, categorias, fragmento_cifrado, acuse_requerido, evidencia_turno_ids FROM evento_riesgo WHERE sesion_id = $1',
      [sesionId],
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]).toMatchObject({ nivel: 3, fuente: 'reglas', acuse_requerido: true });
    expect(ev.rows[0]!.categorias).toContain('ideacion_suicida');
    expect(e.app.cifrador.descifrar(ev.rows[0]!.fragmento_cifrado)).toBe('Ya no quiero vivir, para qué seguir');
    expect(ev.rows[0]!.evidencia_turno_ids).toHaveLength(1);
  });

  it('en emergencia el agente no cierra la conversación y sigue respondiendo con el protocolo', async () => {
    const { sesionId } = await abrir();
    await decir(sesionId, 'Me duele mucho el pecho');
    const c = await pedir<{ cerrada: boolean; motivo: string }>(e.f, 'POST', `/api/conversacion/sesiones/${sesionId}/cerrar`, e.tokens.dispositivo, {});
    expect(c.datos).toEqual({ cerrada: false, motivo: 'emergencia_en_curso' });

    const r = await decir(sesionId, 'Estoy sentada en la cocina');
    expect(r.datos.modoEmergencia).toBe(true);
    expect(r.datos.respuesta).toMatch(/SAMU|131/);
    const s = await e.owner.query('SELECT fin, modo_emergencia FROM sesion_conversacion WHERE id = $1', [sesionId]);
    expect(s.rows[0]).toEqual({ fin: null, modo_emergencia: true });
  });

  it('una emergencia sin acuse sigue activa en una sesión nueva; con acuse humano, no', async () => {
    const primera = await abrir();
    await decir(primera.sesionId, 'Quisiera dormirme y no despertar');
    const segunda = await abrir();
    expect(segunda.modoEmergencia).toBe(true);

    // Acusar una alerta detiene su cadena de escalamiento y acusa los eventos agrupados en ella.
    for (let i = 0; i < 20; i++) {
      const pendientes = (await pedir<{ alertas: Array<{ id: string }> }>(e.f, 'GET', '/api/alertas', e.tokens.guardia)).datos.alertas;
      if (!pendientes.length) break;
      expect((await pedir(e.f, 'POST', `/api/alertas/${pendientes[0]!.id}/acuse`, e.tokens.guardia, {})).estado).toBe(200);
    }
    expect((await abrir()).modoEmergencia).toBe(false);
  });

  it('nivel 2: respuesta segura que avisa y ofrece llamar juntos; queda en la bandeja de alertas', async () => {
    const { sesionId } = await abrir();
    const r = await decir(sesionId, 'Siento que soy una carga para mi hija');
    expect(r.datos.nivel).toBe(2);
    expect(r.datos.modoEmergencia).toBe(false);
    expect(r.datos.respuesta).toMatch(/voy a avisar/);
    expect(r.datos.respuesta).toMatch(/llamamos juntos/);
    const a = await pedir<{ alertas: Array<{ sesion_id: string; nivel: number }> }>(e.f, 'GET', '/api/alertas', e.tokens.supervisor);
    expect(a.datos.alertas.some((x) => x.sesion_id === sesionId && x.nivel === 2)).toBe(true);
  });

  it('nivel 1 se guarda como señal, sin evento de alerta', async () => {
    const { sesionId } = await abrir();
    const r = await decir(sesionId, 'Anoche no pude dormir');
    expect(r.datos.nivel).toBe(1);
    const ev = await e.owner.query('SELECT 1 FROM evento_riesgo WHERE sesion_id = $1', [sesionId]);
    expect(ev.rowCount).toBe(0);
    const s = await e.owner.query<{ tipo: string; valor: string }>('SELECT s.tipo, s.valor FROM senal s JOIN turno t ON t.id = s.origen_turno_id WHERE t.sesion_id = $1', [sesionId]);
    expect(s.rows).toEqual([{ tipo: 'riesgo.sueno', valor: '1' }]);
  });

  it('los umbrales personales del plan terapéutico disparan alertas', async () => {
    const plan = {
      contenido: { objetivos: ['Retomar contacto con su hermana'], umbrales_alerta: [{ id: 'arturo', frase: 'ir a ver a Arturo', nivel: 3, nota: 'esposo fallecido' }], no_mencionar: ['duelo complicado'] },
      motivo: 'Plan inicial tras el onboarding',
      versionBase: null,
    };
    const p = await pedir<{ version: number }>(e.f, 'PUT', `/api/personas/${e.ids.persona}/plan-terapeutico`, e.tokens.supervisor, plan);
    expect(p.datos.version).toBe(1);

    const { sesionId } = await abrir();
    const r = await decir(sesionId, 'Creo que ya es hora de ir a ver a Arturo');
    expect(r.datos.nivel).toBe(3);
    const ev = await e.owner.query<{ fuente: string; detalle: { reglas: string[] } }>('SELECT fuente, detalle FROM evento_riesgo WHERE sesion_id = $1', [sesionId]);
    expect(ev.rows[0]!.fuente).toBe('umbral_personal');
    expect(ev.rows[0]!.detalle.reglas).toContain('personal.arturo');
  });

  it('los turnos de una sesión se procesan en orden aunque lleguen juntos', async () => {
    const { sesionId } = await abrir(e.tokens.dispositivoAjeno);
    await Promise.all(['uno', 'dos', 'tres'].map((t) => decir(sesionId, t, e.tokens.dispositivoAjeno)));
    const t = await e.owner.query<{ orden: number; hablante: string }>('SELECT orden, hablante FROM turno WHERE sesion_id = $1 ORDER BY orden', [sesionId]);
    expect(t.rows.map((x) => x.hablante)).toEqual(['persona', 'agente', 'persona', 'agente', 'persona', 'agente']);
  });

  it('una tablet no puede usar la sesión de otra persona', async () => {
    const { sesionId } = await abrir();
    const r = await decir(sesionId, 'hola', e.tokens.dispositivoAjeno);
    expect(r.estado).toBe(404);
  });

  it('el personal no puede conversar como la persona', async () => {
    const r = await pedir(e.f, 'POST', '/api/conversacion/sesiones', e.tokens.supervisor, {});
    expect(r.estado).toBe(403);
  });

  it('los textos de la conversación quedan cifrados en la base', async () => {
    const { sesionId } = await abrir();
    await decir(sesionId, 'Mi nieta Antonia me trajo empanadas');
    const r = await e.owner.query<{ texto_cifrado: Buffer }>('SELECT texto_cifrado FROM turno WHERE sesion_id = $1', [sesionId]);
    for (const f of r.rows) {
      expect(f.texto_cifrado.toString('utf8')).not.toContain('Antonia');
      expect(f.texto_cifrado.toString('latin1')).not.toContain('empanadas');
    }
    const p = await e.owner.query<{ nombre_cifrado: Buffer }>('SELECT nombre_cifrado FROM persona WHERE id = $1', [e.ids.persona]);
    expect(p.rows[0]!.nombre_cifrado.toString('latin1')).not.toContain('Rosa');
  });

  it('rechaza mensajes vacíos y sesiones cerradas', async () => {
    const t = e.tokens.dispositivoAjeno;
    const { sesionId } = await abrir(t);
    expect((await decir(sesionId, '   ', t)).estado).toBe(400);
    const c = await pedir<{ cerrada: boolean }>(e.f, 'POST', `/api/conversacion/sesiones/${sesionId}/cerrar`, t, {});
    expect(c.datos.cerrada).toBe(true);
    expect((await decir(sesionId, 'hola', t)).estado).toBe(409);
  });
});
