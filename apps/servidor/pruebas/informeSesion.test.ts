import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { esquemaPlan } from '../src/conversacion/plan.ts';
import { cargarConfig } from '../src/config/config.ts';
import { generarInformeSesion, instruccionesInforme, validarInforme, type ContextoValidacion } from '../src/informes/sesion.ts';
import { CLAVES_LENTES, lentesActivas } from '../src/informes/lentes.ts';
import { crearEscenario, pedir, type Escenario } from './escenario.ts';

const TURNOS = [
  'Hola, hoy amanecí con la rodilla mala.',
  'La verdad es que ya no sirvo para nada, estoy de más.',
  'Mi hija Camila no me ha llamado en toda la semana.',
  'Tengo diabetes desde hace años, pero me tomo todo.',
];
const P1 = randomUUID();
const P2 = randomUUID();
const ctx = (extra: Partial<ContextoValidacion> = {}): ContextoValidacion => ({ turnosPersona: TURNOS, lentesActivas: lentesActivas(), sesionesPrevias: new Set([P1, P2]), ...extra });

/** Un informe correcto, que cada prueba estropea en un solo punto. */
const base = () => ({
  temas: [{ tema: 'Dolor de rodilla', minutos_aprox: 2 }, { tema: 'Distancia con la hija', minutos_aprox: 4 }],
  estado_afectivo: { observado: [{ texto: 'Tono desanimado al hablar de sí misma.', citas: ['ya no sirvo para nada'] }], inferido: [{ texto: 'Posible sentimiento de inutilidad, a explorar.', citas: [] }] },
  pensamientos_creencias: { observado: [{ texto: 'Se describe como alguien que sobra.', citas: ['estoy de más'] }], inferido: [] },
  funcionamiento_cotidiano: { observado: [], inferido: [] },
  red_social: { observado: [{ texto: 'Refiere que su hija no la ha llamado.', citas: ['Mi hija Camila no me ha llamado en toda la semana'] }], inferido: [] },
  salud: { observado: [{ texto: 'Refiere diabetes y dice tomar su medicación.', citas: ['Tengo diabetes desde hace años'] }], inferido: [] },
  riesgo: { justificacion: 'Frase indirecta de desesperanza detectada por las reglas.' },
  intervenciones: [{ tipo: 'validación', descripcion: 'El compañero validó su malestar.', respuesta_persona: 'Siguió conversando.', citas: [] }],
  observaciones_supervisor: { hipotesis_tentativas: [{ texto: 'Podría relacionarse con la distancia de la hija.', citas: [] }], temas_pendientes: ['Retomar la rodilla'] },
  lentes: [{ lente: 'lacan', concepto: 'significante que insiste', senalamiento: 'Se nombra como alguien que sobra.', citas: ['estoy de más'], tipo: 'observacion' as 'observacion' | 'lectura', sesiones_previas: [] as string[] }],
});

describe('resumen de sesión: validación contra alucinaciones', () => {
  it('acepta un informe con citas literales, aunque cambien mayúsculas, tildes o puntuación', () => {
    const i = base();
    i.estado_afectivo.observado[0]!.citas = ['Ya no sirvo para nada'];
    i.red_social.observado[0]!.citas = ['mi hija camila no me ha llamado en toda la semana!'];
    const r = validarInforme(i, ctx());
    expect(r.ok, JSON.stringify(!r.ok && r.errores)).toBe(true);
  });

  it('rechaza una cita que la persona no dijo', () => {
    const i = base();
    i.pensamientos_creencias.observado[0]!.citas = ['soy una carga para todos'];
    const r = validarInforme(i, ctx());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errores.join()).toMatch(/no está, tal cual/);
  });

  it('rechaza citas que juntan frases de turnos distintos', () => {
    const i = base();
    i.estado_afectivo.observado[0]!.citas = ['amanecí con la rodilla mala. La verdad es que'];
    expect(validarInforme(i, ctx()).ok).toBe(false);
  });

  it('también verifica lo que va entre comillas dentro de cualquier texto', () => {
    const i = base();
    i.riesgo.justificacion = 'Dijo «nadie me quiere» al final.';
    const r = validarInforme(i, ctx());
    expect(!r.ok && r.errores.join()).toMatch(/entre comillas/);
    const bien = base();
    bien.riesgo.justificacion = 'Frase indirecta: «ya no sirvo para nada».';
    bien.intervenciones[0]!.descripcion = 'Le propuso «llamar a su hija juntos».';
    expect(validarInforme(bien, ctx({ turnosCompanero: ['¿Le parece llamar a su hija juntos?'] })).ok).toBe(true);
  });

  it('los indicadores necesitan una cita de la persona', () => {
    const bien = { ...base(), indicadores: { animo: { valor: -1, cita: 'ya no sirvo para nada' }, sueno: null, apetito: null, contactos_humanos: [] } };
    expect(validarInforme(bien, ctx()).ok).toBe(true);
    const mal = { ...base(), indicadores: { animo: null, sueno: { valor: 'malo', cita: 'no pude dormir nada' }, apetito: null, contactos_humanos: [{ tipo: 'llamada', con_quien: 'hija', cita: 'mi hija me llamó' }] } };
    const r = validarInforme(mal, ctx());
    expect(!r.ok && r.errores.filter((x) => x.startsWith('indicadores')).length).toBe(2);
  });

  it('rechaza diagnósticos en lo inferido, las hipótesis, las lentes y las intervenciones', () => {
    for (const estropear of [
      (i: ReturnType<typeof base>) => { i.estado_afectivo.inferido[0]!.texto = 'Presenta depresión en contexto de duelo.'; },
      (i: ReturnType<typeof base>) => { i.observaciones_supervisor.hipotesis_tentativas[0]!.texto = 'Probable deterioro cognitivo leve.'; },
      (i: ReturnType<typeof base>) => { i.lentes[0]!.senalamiento = 'Indicio de un trastorno de ansiedad.'; },
      (i: ReturnType<typeof base>) => { i.intervenciones[0]!.descripcion = 'Psicoeducación sobre la demencia.'; },
    ]) {
      const i = base();
      estropear(i);
      const r = validarInforme(i, ctx());
      expect(r.ok).toBe(false);
      expect(!r.ok && r.errores.join()).toMatch(/diagnóstico/);
    }
  });

  it('lo observado puede nombrar un diagnóstico solo si la persona lo dijo y se cita', () => {
    const i = base();
    i.salud.observado[0]!.citas = [];
    const r = validarInforme(i, ctx());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errores.join()).toMatch(/sin una cita de la persona/);
  });

  it('una lectura necesita 2 sesiones previas reales; si no, debe ser observación', () => {
    const una = base();
    una.lentes[0] = { ...una.lentes[0]!, tipo: 'lectura', sesiones_previas: [P1] };
    expect(validarInforme(una, ctx()).ok).toBe(false);
    const inventada = base();
    inventada.lentes[0] = { ...inventada.lentes[0]!, tipo: 'lectura', sesiones_previas: [P1, randomUUID()] };
    const r = validarInforme(inventada, ctx());
    expect(!r.ok && r.errores.join()).toMatch(/no se le entregaron/);
    const bien = base();
    bien.lentes[0] = { ...bien.lentes[0]!, tipo: 'lectura', sesiones_previas: [P1, P2] };
    expect(validarInforme(bien, ctx()).ok).toBe(true);
  });

  it('rechaza lentes desactivadas para el caso o que no existen', () => {
    const r = validarInforme(base(), ctx({ lentesActivas: lentesActivas(['lacan']) }));
    expect(!r.ok && r.errores.join()).toMatch(/desactivada/);
    const i = base();
    i.lentes[0]!.lente = 'jung';
    expect(validarInforme(i, ctx()).ok).toBe(false);
  });

  it('rechaza un formato que no corresponde', () => {
    expect(validarInforme({ temas: 'muchos' }, ctx()).ok).toBe(false);
    expect(validarInforme(null, ctx()).ok).toBe(false);
  });
});

describe('lentes teóricas', () => {
  it('todas activas por defecto; la transferencia no se puede desactivar', () => {
    expect(lentesActivas()).toEqual(CLAVES_LENTES);
    expect(lentesActivas(['freud', 'transferencia'])).toContain('transferencia');
    expect(lentesActivas(['freud'])).not.toContain('freud');
    expect(esquemaPlan.safeParse({ lentes_desactivadas: ['transferencia'] }).success).toBe(false);
    expect(esquemaPlan.parse({ lentes_desactivadas: ['klein'] }).lentes_desactivadas).toEqual(['klein']);
    expect(esquemaPlan.parse({}).lentes_desactivadas).toEqual([]);
  });

  it('las instrucciones solo listan las lentes activas', () => {
    const t = instruccionesInforme(lentesActivas(['klein']));
    expect(t).toContain('- transferencia:');
    expect(t).toContain('- lacan:');
    expect(t).not.toContain('- klein:');
  });

  it('sin modelo propio, los informes usan el de la conversación', () => {
    const c = cargarConfig({ DATABASE_URL: 'postgres://x', CLAVE_CIFRADO: 'a'.repeat(64), IA_MODELO_CONVERSACION: 'conv', IA_MODELO_GUARDIAN: 'g' });
    expect(c.ia.tareas.informes.modelo).toBe('conv');
    expect(c.tareasSinModelo).not.toContain('informes');
  });
});

describe('resumen de sesión: generación y acceso', () => {
  let e: Escenario;
  beforeAll(async () => {
    e = await crearEscenario();
  });
  afterAll(async () => e?.cerrar());

  const sesionConTurnos = async (turnosPersona: string[]) => {
    const s = await e.owner.query<{ id: string }>(`INSERT INTO sesion_conversacion (persona_id, iniciada_por, canal, fin) VALUES ($1, 'persona', 'texto', now()) RETURNING id`, [e.ids.persona]);
    const id = s.rows[0]!.id;
    let orden = 0;
    for (const t of turnosPersona) {
      await e.owner.query(`INSERT INTO turno (sesion_id, persona_id, orden, hablante, texto_cifrado, origen) VALUES ($1, $2, $3, 'persona', $4, 'persona')`, [id, e.ids.persona, ++orden, e.app.cifrador.cifrar(t)]);
    }
    return id;
  };

  it('si el proveedor no responde, no se guarda nada y queda el intento registrado', async () => {
    const id = await sesionConTurnos(['Hola, ¿cómo estás?']);
    const r = await generarInformeSesion({ bd: e.app.bd, cifrador: e.app.cifrador, modelos: e.app.modelos }, id);
    expect(r.estado).toBe('error');
    const f = await e.owner.query('SELECT informe_intentos FROM sesion_conversacion WHERE id = $1', [id]);
    expect(f.rows[0].informe_intentos).toBe(1);
    expect((await e.owner.query('SELECT 1 FROM informe_sesion WHERE sesion_id = $1', [id])).rowCount).toBe(0);
  });

  it('una sesión sin palabras de la persona no genera informe ni se reintenta', async () => {
    const id = await sesionConTurnos([]);
    expect((await generarInformeSesion({ bd: e.app.bd, cifrador: e.app.cifrador, modelos: e.app.modelos }, id)).estado).toBe('sin_contenido');
    const f = await e.owner.query('SELECT informe_intentos FROM sesion_conversacion WHERE id = $1', [id]);
    expect(f.rows[0].informe_intentos).toBeGreaterThanOrEqual(3);
  });

  it('el equipo clínico asignado lee el informe (auditado); administración, guardia y otros no', async () => {
    const id = await sesionConTurnos(TURNOS);
    const contenido = { ...base(), version: 1, datos: { inicio: new Date().toISOString(), fin: null, duracionMin: 5, iniciadaPor: 'persona', canal: 'texto', turnosPersona: 4, turnosCompanero: 4 }, nivelRiesgo: 2, lentesActivas: lentesActivas() };
    await e.owner.query(`INSERT INTO informe_sesion (sesion_id, contenido_cifrado, estado_validacion) VALUES ($1, $2, 'valido')`, [id, e.app.cifrador.cifrarJson(contenido)]);
    const url = `/api/personas/${e.ids.persona}/sesiones/${id}/informe`;
    const r = await pedir<{ informe: { estado: string; contenido: { nivelRiesgo: number; lentes: unknown[] } } }>(e.f, 'GET', url, e.tokens.enfermera);
    expect(r.estado).toBe(200);
    expect(r.datos.informe.estado).toBe('valido');
    expect(r.datos.informe.contenido.nivelRiesgo).toBe(2);
    for (const t of [e.tokens.admin, e.tokens.guardia, e.tokens.supervisorAjeno, e.tokens.familiar, e.tokens.dispositivo]) expect((await pedir(e.f, 'GET', url, t)).estado).toBe(403);
    const a = await e.owner.query(`SELECT count(*)::int AS n FROM registro_auditoria WHERE accion = 'informe_sesion.leer' AND recurso_id = $1`, [id]);
    expect(a.rows[0].n).toBe(1);
    // Cifrado en la base.
    const crudo = await e.owner.query('SELECT contenido_cifrado FROM informe_sesion WHERE sesion_id = $1', [id]);
    expect(crudo.rows[0].contenido_cifrado.toString('utf8')).not.toContain('sirvo');
    // Uno válido no se regenera.
    expect((await pedir(e.f, 'POST', `${url}/regenerar`, e.tokens.supervisor)).estado).toBe(409);
  });

  it('solo el supervisor asignado pide regenerarlo', async () => {
    const id = await sesionConTurnos(['Hoy salí a caminar al lago.']);
    const url = `/api/personas/${e.ids.persona}/sesiones/${id}/informe/regenerar`;
    expect((await pedir(e.f, 'POST', url, e.tokens.enfermera)).estado).toBe(403);
    expect((await pedir(e.f, 'POST', url, e.tokens.supervisorAjeno)).estado).toBe(403);
    expect((await pedir(e.f, 'POST', url, e.tokens.supervisor)).estado).toBe(202);
  });
});
