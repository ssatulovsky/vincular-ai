import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GDS15, UCLA3, puntuar, type Respuesta } from '../src/tamizaje/instrumentos.ts';
import { instruccionesTamizaje, registrarRespuesta, tamizajesEnCurso } from '../src/tamizaje/tamizaje.ts';
import { evaluarDependencia, generarInformeSemanal, lineaBase, metricasPorSemana, senalDependenciaReciente, type MetricasSemana } from '../src/informes/evolucion.ts';
import { lentesActivas } from '../src/informes/lentes.ts';
import { crearEscenario, pedir, type Escenario } from './escenario.ts';

const semana = (s: string, minutos: number, contactos: number, extra: Partial<MetricasSemana> = {}): MetricasSemana => ({
  semana: s, sesiones: minutos ? 3 : 0, minutos, iniciadasPorPersona: 1, nivelMaximo: 0, alertas: 0, adherencia: { confirmadas: 0, total: 0, porcentaje: null },
  animo: { promedio: null, registros: 0 }, suenoMalo: 0, apetitoMalo: 0, contactosHumanos: contactos, historiasRepetidas: 0, ...extra,
});

describe('instrumentos de tamizaje', () => {
  it('GDS-15: las preguntas positivas puntúan con "no"; el resto con "sí"', () => {
    const todasSi = Object.fromEntries(GDS15.items.map((i) => [i.numero, 'si'])) as Record<number, Respuesta>;
    // Con "sí" a todo, puntúan las 10 preguntas negativas.
    expect(puntuar(GDS15, todasSi)).toEqual({ puntaje: 10, elevado: true, completo: true });
    const sinSintomas = Object.fromEntries(GDS15.items.map((i) => [i.numero, i.puntaje.si === 0 ? 'si' : 'no'])) as Record<number, Respuesta>;
    expect(puntuar(GDS15, sinSintomas)).toEqual({ puntaje: 0, elevado: false, completo: true });
  });

  it('GDS-15: corte en 5 (el más bajo habitual); incompleto no es resultado', () => {
    const cuatro = { 2: 'si', 3: 'si', 4: 'si', 6: 'si' } as Record<number, Respuesta>;
    expect(puntuar(GDS15, cuatro)).toMatchObject({ puntaje: 4, elevado: false, completo: false });
    expect(puntuar(GDS15, { ...cuatro, 8: 'si' }).elevado).toBe(true);
  });

  it('UCLA-3: de 3 a 9 puntos, elevado desde 6', () => {
    expect(puntuar(UCLA3, { 1: 'casi_nunca', 2: 'casi_nunca', 3: 'casi_nunca' }).puntaje).toBe(3);
    expect(puntuar(UCLA3, { 1: 'a_menudo', 2: 'a_veces', 3: 'casi_nunca' })).toEqual({ puntaje: 6, elevado: true, completo: true });
  });
});

describe('señal de dependencia', () => {
  it('se detecta si el uso sube y el contacto humano baja (2 semanas contra las 2 anteriores)', () => {
    const s = [semana('a', 60, 6), semana('b', 60, 6), semana('c', 100, 3), semana('d', 110, 2)];
    expect(evaluarDependencia(s).detectada).toBe(true);
  });

  it('no se detecta si sube el uso pero también el contacto, o con pocos datos', () => {
    expect(evaluarDependencia([semana('a', 60, 6), semana('b', 60, 6), semana('c', 100, 8), semana('d', 110, 7)]).detectada).toBe(false);
    expect(evaluarDependencia([semana('a', 60, 6), semana('b', 60, 6), semana('c', 100, 2)]).detectada).toBe(false);
    // Sin contactos registrados antes no se puede medir una baja.
    expect(evaluarDependencia([semana('a', 60, 0), semana('b', 60, 0), semana('c', 100, 0), semana('d', 110, 0)]).motivo).toMatch(/no se puede medir/);
  });

  it('la línea base son las dos primeras semanas con conversaciones', () => {
    const b = lineaBase([semana('0', 0, 0), semana('1', 40, 4, { animo: { promedio: -1, registros: 2 } }), semana('2', 60, 2, { animo: { promedio: 0, registros: 1 } }), semana('3', 200, 0)]);
    expect(b).toEqual({ desde: '1', minutosSemana: 50, contactosSemana: 3, animoPromedio: -0.5, adherencia: null });
  });
});

describe('tamizaje conversacional', () => {
  let e: Escenario;
  beforeAll(async () => {
    e = await crearEscenario();
  });
  afterAll(async () => e?.cerrar());

  const turno = async (sesionId: string, texto: string) => {
    const r = await e.owner.query<{ id: string }>(
      `INSERT INTO turno (sesion_id, persona_id, orden, hablante, texto_cifrado, origen) VALUES ($1, $2, (SELECT coalesce(max(orden), 0) + 1 FROM turno WHERE sesion_id = $1), 'persona', $3, 'persona') RETURNING id`,
      [sesionId, e.ids.persona, e.app.cifrador.cifrar(texto)],
    );
    return r.rows[0]!.id;
  };
  const sesion = async () => (await e.owner.query<{ id: string }>(`INSERT INTO sesion_conversacion (persona_id, iniciada_por, canal) VALUES ($1, 'persona', 'voz') RETURNING id`, [e.ids.persona])).rows[0]!.id;
  const responder = async (sesionId: string, instrumento: string, item: number, respuesta: string, dicho: string, cita = dicho) => {
    const turnoId = await turno(sesionId, dicho);
    return registrarRespuesta({ bd: e.app.bd, cifrador: e.app.cifrador, personaId: e.ids.persona, sesionId, turnoPersonaId: turnoId, textoPersona: dicho, ahora: new Date() }, { instrumento, item, respuesta, cita });
  };

  it('solo el supervisor asignado lo inicia; uno a la vez por instrumento', async () => {
    const url = `/api/personas/${e.ids.persona}/tamizajes`;
    expect((await pedir(e.f, 'POST', url, e.tokens.enfermera, { instrumento: 'ucla3' })).estado).toBe(403);
    expect((await pedir(e.f, 'POST', url, e.tokens.admin, { instrumento: 'ucla3' })).estado).toBe(403);
    expect((await pedir(e.f, 'POST', url, e.tokens.supervisor, { instrumento: 'ucla3' })).estado).toBe(201);
    expect((await pedir(e.f, 'POST', url, e.tokens.supervisor, { instrumento: 'ucla3' })).estado).toBe(409);
  });

  it('el compañero recibe la siguiente pregunta, nunca puntajes', async () => {
    const t = await tamizajesEnCurso(e.app.bd, e.app.cifrador, e.ids.persona);
    const texto = instruccionesTamizaje(t);
    expect(texto).toContain('¿Con qué frecuencia siente que le falta compañía?');
    expect(texto).toMatch(/Nunca comentes puntajes/);
    expect(instruccionesTamizaje([])).toBe('');
  });

  it('una respuesta solo se registra con una cita de lo que la persona acaba de decir', async () => {
    const s = await sesion();
    const mal = await responder(s, 'ucla3', 1, 'a_menudo', 'Sí, harto, me falta compañía', 'casi siempre estoy sola');
    expect(mal).toHaveProperty('error');
    expect(await responder(s, 'ucla3', 1, 'muchas_veces', 'Me falta compañía a menudo')).toHaveProperty('error');
    expect(await responder(s, 'gds15', 1, 'si', 'Sí, estoy satisfecha')).toMatchObject({ error: expect.stringMatching(/No hay un tamizaje/) });
    const bien = await responder(s, 'ucla3', 1, 'a_menudo', 'Sí, harto, me falta compañía', 'me falta compañía');
    expect(bien).toMatchObject({ registrada: true, quedan: 2, completado: false });
  });

  it('UCLA-3 completo: queda el resultado y la señal, sin alerta (nivel 1)', async () => {
    const s = await sesion();
    await responder(s, 'ucla3', 2, 'a_veces', 'A veces me siento dejada de lado');
    const fin = await responder(s, 'ucla3', 3, 'a_menudo', 'Seguido me siento aislada');
    expect(fin).toEqual({ registrada: true, completado: true, elevado: true });
    const r = await e.owner.query(`SELECT puntaje FROM resultado_tamizaje WHERE persona_id = $1 AND instrumento = 'ucla3'`, [e.ids.persona]);
    expect(Number(r.rows[0].puntaje)).toBe(8);
    const ev = await e.owner.query(`SELECT 1 FROM evento_riesgo WHERE persona_id = $1 AND 'tamizaje_ucla3_elevado' = ANY(categorias)`, [e.ids.persona]);
    expect(ev.rowCount).toBe(0);
    // Las respuestas, con sus citas, quedan cifradas.
    const crudo = await e.owner.query(`SELECT items_cifrado FROM resultado_tamizaje WHERE persona_id = $1 AND instrumento = 'ucla3'`, [e.ids.persona]);
    expect(crudo.rows[0].items_cifrado.toString('utf8')).not.toContain('aislada');
  });

  it('GDS-15 elevado: alerta de nivel 2 en la bandeja y cadena de avisos', async () => {
    await pedir(e.f, 'POST', `/api/personas/${e.ids.persona}/tamizajes`, e.tokens.supervisor, { instrumento: 'gds15' });
    const s = await sesion();
    for (const item of GDS15.items) {
      // Respuestas con síntomas en 6 de las 15 preguntas.
      const conSintoma = item.numero <= 6;
      const respuesta = conSintoma ? (item.puntaje.si === 1 ? 'si' : 'no') : item.puntaje.si === 1 ? 'no' : 'si';
      const dicho = respuesta === 'si' ? 'Sí, la verdad que sí' : 'No, para nada';
      const r = await responder(s, 'gds15', item.numero, respuesta, dicho);
      expect(r).not.toHaveProperty('error');
    }
    const res = await e.owner.query(`SELECT puntaje FROM resultado_tamizaje WHERE persona_id = $1 AND instrumento = 'gds15'`, [e.ids.persona]);
    expect(Number(res.rows[0].puntaje)).toBe(6);
    const ev = await e.owner.query<{ id: string; nivel: number; fuente: string }>(`SELECT id, nivel, fuente FROM evento_riesgo WHERE persona_id = $1 AND 'tamizaje_gds15_elevado' = ANY(categorias)`, [e.ids.persona]);
    expect(ev.rows[0]).toMatchObject({ nivel: 2, fuente: 'sistema' });
    const esc = await e.owner.query(`SELECT 1 FROM escalamiento WHERE persona_id = $1 AND tipo_evento = 'riesgo' AND estado = 'en_curso'`, [e.ids.persona]);
    expect(esc.rowCount).toBeGreaterThan(0);
    const alertas = await pedir<{ alertas: Array<{ id: string }> }>(e.f, 'GET', '/api/alertas', e.tokens.supervisor);
    expect(alertas.datos.alertas.some((a) => a.id === ev.rows[0]!.id)).toBe(true);
  });

  it('el panel muestra resultados y avance, sin las respuestas; administración no', async () => {
    const r = await pedir<{ tamizaje: { resultados: Array<{ instrumento: string; puntaje: number; elevado: boolean }>; enCurso: unknown[] } }>(e.f, 'GET', `/api/personas/${e.ids.persona}/evolucion`, e.tokens.enfermera);
    expect(r.estado).toBe(200);
    expect(r.datos.tamizaje.resultados.map((x) => x.instrumento).sort()).toEqual(['gds15', 'ucla3']);
    expect(JSON.stringify(r.datos)).not.toContain('la verdad que sí');
    expect((await pedir(e.f, 'GET', `/api/personas/${e.ids.persona}/evolucion`, e.tokens.admin)).estado).toBe(403);
    expect((await pedir(e.f, 'GET', `/api/personas/${e.ids.persona}/evolucion`, e.tokens.supervisorAjeno)).estado).toBe(403);
  });

  it('se puede cancelar un tamizaje en curso (solo el supervisor)', async () => {
    const t = (await pedir<{ id: string }>(e.f, 'POST', `/api/personas/${e.ids.personaAjena}/tamizajes`, e.tokens.supervisorAjeno, { instrumento: 'gds15' })).datos.id;
    expect((await pedir(e.f, 'POST', `/api/personas/${e.ids.personaAjena}/tamizajes/${t}/cancelar`, e.tokens.supervisor)).estado).toBe(403);
    expect((await pedir(e.f, 'POST', `/api/personas/${e.ids.personaAjena}/tamizajes/${t}/cancelar`, e.tokens.supervisorAjeno)).estado).toBe(200);
    expect(await tamizajesEnCurso(e.app.bd, e.app.cifrador, e.ids.personaAjena)).toEqual([]);
  });

  it('métricas por semana desde la base: minutos, ánimo y contactos humanos de los resúmenes', async () => {
    const p = e.ids.personaAjena;
    const ahora = new Date('2030-06-19T15:00:00Z'); // miércoles
    const s1 = (await e.owner.query<{ id: string }>(
      `INSERT INTO sesion_conversacion (persona_id, iniciada_por, canal, inicio, fin) VALUES ($1, 'persona', 'voz', '2030-06-10T14:00:00Z', '2030-06-10T14:20:00Z') RETURNING id`, [p])).rows[0]!.id;
    const s2 = (await e.owner.query<{ id: string }>(
      `INSERT INTO sesion_conversacion (persona_id, iniciada_por, canal, inicio, fin) VALUES ($1, 'agente', 'voz', '2030-06-17T14:00:00Z', '2030-06-17T14:10:00Z') RETURNING id`, [p])).rows[0]!.id;
    const informe = (animo: number, contactos: number) => ({
      temas: [], estado_afectivo: { observado: [], inferido: [] }, pensamientos_creencias: { observado: [], inferido: [] }, funcionamiento_cotidiano: { observado: [], inferido: [] },
      red_social: { observado: [], inferido: [] }, salud: { observado: [], inferido: [] }, riesgo: { justificacion: 'Sin señales.' }, intervenciones: [], observaciones_supervisor: { hipotesis_tentativas: [], temas_pendientes: [] },
      indicadores: { animo: { valor: animo, cita: 'x' }, sueno: { valor: 'malo', cita: 'x' }, apetito: null, contactos_humanos: Array.from({ length: contactos }, () => ({ tipo: 'llamada', con_quien: '', cita: 'x' })) },
      lentes: [], version: 1, datos: {}, nivelRiesgo: 0, lentesActivas: lentesActivas(),
    });
    await e.owner.query(`INSERT INTO informe_sesion (sesion_id, contenido_cifrado, estado_validacion) VALUES ($1, $2, 'valido'), ($3, $4, 'valido')`, [s1, e.app.cifrador.cifrarJson(informe(1, 3)), s2, e.app.cifrador.cifrarJson(informe(-1, 1))]);
    const m = await metricasPorSemana(e.app.bd, e.app.cifrador, p, ahora);
    const w1 = m.find((x) => x.semana === '2030-06-10')!;
    const w2 = m.find((x) => x.semana === '2030-06-17')!;
    expect(w1).toMatchObject({ sesiones: 1, minutos: 20, iniciadasPorPersona: 1, contactosHumanos: 3, suenoMalo: 1, animo: { promedio: 1, registros: 1 } });
    expect(w2).toMatchObject({ sesiones: 1, minutos: 10, iniciadasPorPersona: 0, contactosHumanos: 1, animo: { promedio: -1, registros: 1 } });

    // Informe semanal de la semana anterior: con el proveedor caído, queda con las cifras.
    expect(await generarInformeSemanal({ bd: e.app.bd, cifrador: e.app.cifrador, modelos: e.app.modelos }, p, '2030-06-10', ahora)).toBe('solo_cifras');
    const w = await e.owner.query('SELECT contenido_cifrado FROM informe_semanal WHERE persona_id = $1', [p]);
    expect((e.app.cifrador.descifrarJson(w.rows[0].contenido_cifrado) as { metricas: { minutos: number } }).metricas.minutos).toBe(20);
  });

  it('con señal de dependencia, el listado la marca y el compañero refuerza el puente', async () => {
    await e.owner.query(`INSERT INTO senal (persona_id, tipo, valor) VALUES ($1, 'dependencia.uso_sube_contacto_baja', 1)`, [e.ids.persona]);
    expect(await senalDependenciaReciente(e.app.bd, e.ids.persona)).toBe(true);
    const r = await pedir<{ personas: Array<{ id: string; dependencia: boolean }> }>(e.f, 'GET', '/api/personas', e.tokens.supervisor);
    expect(r.datos.personas.find((x) => x.id === e.ids.persona)?.dependencia).toBe(true);
    const admin = await pedir<{ personas: Array<{ id: string }> }>(e.f, 'GET', '/api/personas', e.tokens.admin);
    expect(admin.datos.personas.find((x) => x.id === e.ids.persona)).not.toHaveProperty('dependencia');
  });

  it('el supervisor marca un desvío del compañero respecto del plan; queda cifrado', async () => {
    const s = await sesion();
    const url = `/api/personas/${e.ids.persona}/sesiones/${s}/desvios`;
    expect((await pedir(e.f, 'POST', url, e.tokens.enfermera, { comentario: 'Profundizó en la enfermedad del esposo, contra el plan.' })).estado).toBe(403);
    expect((await pedir(e.f, 'POST', url, e.tokens.supervisor, { comentario: 'corto' })).estado).toBe(400);
    expect((await pedir(e.f, 'POST', url, e.tokens.supervisor, { comentario: 'Profundizó en la enfermedad del esposo, contra el plan.' })).estado).toBe(201);
    const r = await pedir<{ desvios: Array<{ comentario: string; autor: string }> }>(e.f, 'GET', `/api/personas/${e.ids.persona}/evolucion`, e.tokens.supervisor);
    expect(r.datos.desvios[0]).toMatchObject({ comentario: 'Profundizó en la enfermedad del esposo, contra el plan.', autor: 'Prof supervisor_clinico' });
    const crudo = await e.owner.query('SELECT comentario_cifrado FROM desvio_agente WHERE sesion_id = $1', [s]);
    expect(crudo.rows[0].comentario_cifrado.toString('utf8')).not.toContain('esposo');
  });
});
