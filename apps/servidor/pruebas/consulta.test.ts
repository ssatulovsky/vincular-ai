import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tocaPrivado } from '../src/informes/consulta.ts';
import { comparable } from '../src/informes/sesion.ts';
import { lentesActivas } from '../src/informes/lentes.ts';
import { crearEscenario, pedir, type Escenario } from './escenario.ts';

describe('informe para consulta: filtro de lo privado', () => {
  const marcas = { citas: [comparable('mi hermano me debe plata')], turnos: [comparable('Le cuento algo: mi hermano me debe plata y no duermo pensando en eso')], palabras: new Set(['hermano']) };

  it('omite lo que viene del mismo turno, comparte la cita o una palabra distintiva del tema privado', () => {
    expect(tocaPrivado({ texto: 'Duerme mal.', citas: ['no duermo pensando en eso'] }, marcas)).toBe(true);
    expect(tocaPrivado({ texto: 'Preocupación económica.', citas: ['me debe plata'] }, marcas)).toBe(true);
    expect(tocaPrivado({ texto: 'Habló de su hermano.', citas: [] }, marcas)).toBe(true);
  });

  it('deja pasar lo que no toca el tema privado', () => {
    expect(tocaPrivado({ texto: 'Dolor de rodilla al subir la escalera.', citas: ['me duele la rodilla'] }, marcas)).toBe(false);
  });
});

describe('informe para consulta: generación', () => {
  let e: Escenario;
  let cita: string;
  beforeAll(async () => {
    e = await crearEscenario();
    const P = e.ids.persona;
    cita = (await pedir<{ id: string }>(e.f, 'POST', `/api/personas/${P}/citas`, e.tokens.enfermera, { lugar: 'CESFAM Puerto Varas', profesional: 'Dra. Pérez', fecha: new Date(Date.now() + 3 * 864e5).toISOString(), motivo: 'Control de presión' })).datos.id;
    const s = (await e.owner.query<{ id: string }>(`INSERT INTO sesion_conversacion (persona_id, iniciada_por, canal, fin) VALUES ($1, 'persona', 'voz', now()) RETURNING id`, [P])).rows[0]!.id;
    const turno = async (orden: number, texto: string) =>
      (await e.owner.query<{ id: string }>(`INSERT INTO turno (sesion_id, persona_id, orden, hablante, texto_cifrado, origen) VALUES ($1, $2, $3, 'persona', $4, 'persona') RETURNING id`, [s, P, orden, e.app.cifrador.cifrar(texto)])).rows[0]!.id;
    await turno(1, 'Me duele la rodilla cuando subo la escalera.');
    const privado = await turno(2, 'Le cuento algo: mi hermano Raúl me debe plata y no duermo pensando en eso.');
    // La persona marcó ese tema como privado.
    await e.owner.query(`INSERT INTO hecho_memoria (persona_id, capa, contenido_cifrado, privado, origen_turno_id, cita_cifrada) VALUES ($1, 'relacional', $2, true, $3, $4)`, [
      P, e.app.cifrador.cifrar('Su hermano Raúl le debe dinero'), privado, e.app.cifrador.cifrar('mi hermano Raúl me debe plata'),
    ]);
    const informe = {
      temas: [], estado_afectivo: { observado: [], inferido: [] }, pensamientos_creencias: { observado: [], inferido: [] }, red_social: { observado: [], inferido: [] },
      funcionamiento_cotidiano: { observado: [{ texto: 'Duerme mal por preocupaciones.', citas: ['no duermo pensando en eso'] }], inferido: [] },
      salud: { observado: [{ texto: 'Dolor de rodilla al subir escaleras.', citas: ['Me duele la rodilla cuando subo la escalera'] }], inferido: [{ texto: 'Posible limitación de la movilidad.', citas: [] }] },
      riesgo: { justificacion: 'Sin señales.' }, intervenciones: [], observaciones_supervisor: { hipotesis_tentativas: [{ texto: 'Hipótesis que no debe salir.', citas: [] }], temas_pendientes: [] },
      indicadores: { animo: { valor: 0, cita: 'x' }, sueno: { valor: 'malo', cita: 'x' }, apetito: null, contactos_humanos: [] },
      lentes: [{ lente: 'freud', concepto: 'desplazamiento', senalamiento: 'Lectura que no debe salir.', citas: ['Me duele la rodilla'], tipo: 'observacion', sesiones_previas: [] }],
      version: 1, datos: {}, nivelRiesgo: 0, lentesActivas: lentesActivas(),
    };
    await e.owner.query(`INSERT INTO informe_sesion (sesion_id, contenido_cifrado, estado_validacion) VALUES ($1, $2, 'valido')`, [s, e.app.cifrador.cifrarJson(informe)]);
    await e.owner.query(`INSERT INTO pregunta_control (persona_id, texto_cifrado) VALUES ($1, $2)`, [P, e.app.cifrador.cifrar('¿Puedo tomar algo para el dolor de rodilla?')]);
  });
  afterAll(async () => e?.cerrar());

  const url = () => `/api/personas/${e.ids.persona}/citas/${cita}/informe-consulta`;
  const cuerpo = { destinatario: 'Dra. Pérez, CESFAM Puerto Varas', forma: 'verbal', autorizacionConfirmada: true };

  it('sin confirmar la autorización de la persona, no se genera', async () => {
    const r = await pedir<{ detalle: Array<{ mensaje: string }> }>(e.f, 'POST', url(), e.tokens.enfermera, { ...cuerpo, autorizacionConfirmada: false });
    expect(r.estado).toBe(400);
    expect(r.datos.detalle[0]!.mensaje).toMatch(/autorizó/);
  });

  it('solo el equipo clínico asignado lo genera', async () => {
    for (const t of [e.tokens.admin, e.tokens.guardia, e.tokens.supervisorAjeno, e.tokens.familiar, e.tokens.dispositivo]) expect((await pedir(e.f, 'POST', url(), t, cuerpo)).estado).toBe(403);
  });

  it('trae lo registrado del período y deja fuera lo privado, las hipótesis y las lecturas', async () => {
    const r = await e.f.inject({ method: 'POST', url: url(), headers: { authorization: `Bearer ${e.tokens.enfermera}` }, payload: cuerpo });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'");
    const html = r.body;
    expect(html).toContain('Informe para consulta');
    expect(html).toContain('Dra. Pérez, CESFAM Puerto Varas');
    expect(html).toContain('Dolor de rodilla al subir escaleras.');
    expect(html).toContain('«Me duele la rodilla cuando subo la escalera»');
    expect(html).toContain('¿Puedo tomar algo para el dolor de rodilla?');
    for (const prohibido of ['Raúl', 'plata', 'no duermo pensando', 'Hipótesis que no debe salir', 'Lectura que no debe salir', 'limitación de la movilidad']) expect(html, prohibido).not.toContain(prohibido);
    expect(html).toMatch(/Se omitieron 1 registro que tocan temas que la persona marcó como privados/);
    const a = await e.owner.query<{ detalle: { destinatario: string; omitidasPorPrivadas: number } }>(`SELECT detalle FROM registro_auditoria WHERE accion = 'informe_consulta.generar' AND recurso_id = $1`, [cita]);
    expect(a.rows[0]!.detalle).toMatchObject({ destinatario: 'Dra. Pérez, CESFAM Puerto Varas', omitidasPorPrivadas: 1 });
  });

  it('escapa el HTML de lo que dijo la persona', async () => {
    await e.owner.query(`INSERT INTO pregunta_control (persona_id, texto_cifrado) VALUES ($1, $2)`, [e.ids.persona, e.app.cifrador.cifrar('<script>alert(1)</script>')]);
    const r = await e.f.inject({ method: 'POST', url: url(), headers: { authorization: `Bearer ${e.tokens.supervisor}` }, payload: cuerpo });
    expect(r.body).not.toContain('<script>alert(1)</script>');
    expect(r.body).toContain('&lt;script&gt;');
  });
});
