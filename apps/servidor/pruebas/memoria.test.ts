import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { construirInstrucciones } from '../src/conversacion/instrucciones.ts';
import { PERFIL_POR_DEFECTO } from '../src/conversacion/perfil.ts';
import { esquemaPlan } from '../src/conversacion/plan.ts';
import { ejecutarHerramienta, type AmbitoHerramienta } from '../src/conversacion/herramientas.ts';
import { abrirSesion, insertarTurno } from '../src/conversacion/repositorio.ts';
import { buscarEpisodios } from '../src/memoria/episodica.ts';
import { procesarSesion, turnoDeLaCita, validarExtraccion } from '../src/memoria/extraccion.ts';
import { crearHecho, type Hecho } from '../src/memoria/hechos.ts';
import { crearEscenario, pedir, type Escenario } from './escenario.ts';

let e: Escenario;
beforeAll(async () => {
  e = await crearEscenario();
});
afterAll(async () => e?.cerrar());

const turnos = [
  { id: 't1', texto: 'Mi nieta Camila vive en Temuco y estudia enfermería.' },
  { id: 't2', texto: 'El doctor me dijo que tengo diabetes, pero no le cuente a mi hija.' },
  { id: 't3', texto: 'Sí, la Camila es la que vive en Temuco.' },
];
const existente = (id: string, contenido: string, estado: Hecho['estado'] = 'confirmado'): Hecho => ({ id, capa: 'relacional', contenido, privado: false, estado, fuente: 'extraccion', actualizadoEn: new Date() });

describe('validación de la extracción (contra alucinaciones)', () => {
  it('acepta hechos con cita literal y descarta los inventados', () => {
    const r = validarExtraccion(
      {
        hechos_nuevos: [
          { capa: 'relacional', contenido: 'Su nieta Camila vive en Temuco', privado: false, cita: 'Mi nieta Camila vive en Temuco' },
          { capa: 'biografica', contenido: 'Trabajó de profesora', privado: false, cita: 'yo fui profesora treinta años' },
        ],
      },
      turnos,
      [],
    )!;
    expect(r.hechosNuevos).toEqual([{ capa: 'relacional', contenido: 'Su nieta Camila vive en Temuco', privado: false, cita: 'Mi nieta Camila vive en Temuco', turnoId: 't1' }]);
    expect(r.descartados).toEqual([{ tipo: 'hecho', motivo: 'cita_no_encontrada' }]);
  });

  it('la cita se compara sin tildes ni mayúsculas, pero con palabras completas', () => {
    expect(turnoDeLaCita('mi nieta camila vive en temuco', turnos)).toBe('t1');
    expect(turnoDeLaCita('nieta Cami', turnos)).toBeNull();
    expect(turnoDeLaCita('Temuco', turnos)).toBeNull();
  });

  it('no acepta diagnósticos que la persona no dijo, pero sí los que contó ella', () => {
    const r = validarExtraccion(
      {
        hechos_nuevos: [
          { capa: 'salud', contenido: 'Tiene diabetes', privado: true, cita: 'el doctor me dijo que tengo diabetes' },
          { capa: 'salud', contenido: 'Muestra signos de depresión', privado: false, cita: 'Mi nieta Camila vive en Temuco' },
        ],
        resumen: 'Habló de su nieta. Parece tener demencia.',
      },
      turnos,
      [],
    )!;
    expect(r.hechosNuevos.map((h) => h.contenido)).toEqual(['Tiene diabetes']);
    expect(r.hechosNuevos[0]!.privado).toBe(true);
    expect(r.resumen).toBeNull();
    expect(r.descartados.map((d) => d.motivo)).toEqual(['diagnostico_no_dicho', 'diagnostico_no_dicho']);
  });

  it('no duplica hechos existentes y solo corrige o confirma hechos que existen', () => {
    const r = validarExtraccion(
      {
        hechos_nuevos: [{ capa: 'relacional', contenido: 'Su nieta Camila vive en Temuco', privado: false, cita: 'Mi nieta Camila vive en Temuco' }],
        correcciones: [
          { hecho_id: 'h1', contenido: 'Su nieta Camila vive en Temuco', cita: 'la Camila es la que vive en Temuco' },
          { hecho_id: 'inventado', contenido: 'x x x', cita: 'la Camila es la que vive en Temuco' },
        ],
        confirmaciones: [
          { hecho_id: 'h2', cita: 'Sí, la Camila es la que vive en Temuco' },
          { hecho_id: 'h1', cita: 'Sí, la Camila es la que vive en Temuco' },
        ],
      },
      turnos,
      [existente('h1', 'Su nieta Camila vive en Valdivia'), existente('h2', 'Su nieta se llama Camila', 'por_confirmar'), existente('h3', 'Su nieta Camila vive en Temuco')],
    )!;
    expect(r.hechosNuevos).toEqual([]);
    expect(r.correcciones.map((c) => c.hechoId)).toEqual(['h1']);
    expect(r.confirmaciones).toEqual(['h2']);
    expect(r.descartados.map((d) => d.motivo)).toEqual(['duplicado', 'hecho_inexistente', 'hecho_inexistente_o_confirmado']);
  });

  it('devuelve null si el modelo no respetó el formato', () => {
    expect(validarExtraccion({ hechos_nuevos: 'muchos' }, turnos, [])).toBeNull();
    expect(validarExtraccion(null, turnos, [])).toBeNull();
  });
});

describe('procesamiento de sesiones', () => {
  it('si el modelo no responde, no escribe nada y la sesión queda pendiente para reintentar', async () => {
    const sesionId = await abrirSesion(e.app.bd, e.ids.persona, null, 'persona', 'texto');
    await insertarTurno(e.app.bd, e.app.cifrador, sesionId, e.ids.persona, 'persona', 'Mi perro se llama Canela', 'persona');
    const antes = await e.owner.query('SELECT count(*)::int AS n FROM hecho_memoria WHERE persona_id = $1', [e.ids.persona]);
    const r = await procesarSesion(e.app, sesionId);
    expect(r.estado).toBe('error');
    const s = await e.owner.query('SELECT memoria_procesada_en, memoria_intentos, memoria_ultimo_error FROM sesion_conversacion WHERE id = $1', [sesionId]);
    expect(s.rows[0]).toMatchObject({ memoria_procesada_en: null, memoria_intentos: 1 });
    expect(s.rows[0].memoria_ultimo_error).toBeTruthy();
    const despues = await e.owner.query('SELECT count(*)::int AS n FROM hecho_memoria WHERE persona_id = $1', [e.ids.persona]);
    expect(despues.rows[0].n).toBe(antes.rows[0].n);

    // Tras 5 intentos fallidos se deja de reintentar (queda el error registrado).
    for (let i = 0; i < 4; i++) await procesarSesion(e.app, sesionId);
    const fin = await e.owner.query('SELECT memoria_procesada_en, memoria_intentos FROM sesion_conversacion WHERE id = $1', [sesionId]);
    expect(fin.rows[0].memoria_intentos).toBe(5);
    expect(fin.rows[0].memoria_procesada_en).not.toBeNull();
    expect((await procesarSesion(e.app, sesionId)).estado).toBe('ya_procesada');
  });

  it('una sesión sin turnos de la persona se marca procesada sin llamar al modelo', async () => {
    const sesionId = await abrirSesion(e.app.bd, e.ids.persona, null, 'agente', 'texto');
    expect((await procesarSesion(e.app, sesionId)).estado).toBe('sin_contenido');
  });

  it('cerrar la sesión desde la tablet dispara la extracción en segundo plano', async () => {
    const t = e.tokens.dispositivoAjeno;
    const { sesionId } = (await pedir<{ sesionId: string }>(e.f, 'POST', '/api/conversacion/sesiones', t, {})).datos;
    await pedir(e.f, 'POST', `/api/conversacion/sesiones/${sesionId}/turnos`, t, { texto: 'Hoy fui a la feria' });
    await pedir(e.f, 'POST', `/api/conversacion/sesiones/${sesionId}/cerrar`, t, {});
    await Promise.allSettled([...e.app.tareasPendientes]);
    const s = await e.owner.query('SELECT memoria_intentos FROM sesion_conversacion WHERE id = $1', [sesionId]);
    expect(s.rows[0].memoria_intentos).toBe(1);
  });
});

describe('herramientas de memoria del agente', () => {
  let ambito: AmbitoHerramienta;
  let sesionId: string;
  beforeAll(async () => {
    sesionId = await abrirSesion(e.app.bd, e.ids.persona, null, 'persona', 'texto');
    const turno = await insertarTurno(e.app.bd, e.app.cifrador, sesionId, e.ids.persona, 'persona', 'Me encanta el jardín', 'persona');
    ambito = { bd: e.app.bd, cifrador: e.app.cifrador, modelos: e.app.modelos, personaId: e.ids.persona, sesionId, dispositivoId: null, turnoPersonaId: turno, alReportarRiesgo: () => undefined };
  });

  it('guardar, recordar, confirmar, corregir, marcar privado y olvidar', async () => {
    const g = (await ejecutarHerramienta(ambito, 'memoria_guardar_hecho', { capa: 'preferencias', contenido: 'Le encanta el jardín', privado: false })) as { id: string };
    const lista = (await ejecutarHerramienta(ambito, 'memoria_que_recuerdo', {})) as { porCapa: Record<string, Array<{ id: string; porConfirmar: boolean }>> };
    expect(lista.porCapa.preferencias!.find((h) => h.id === g.id)?.porConfirmar).toBe(true);

    expect(await ejecutarHerramienta(ambito, 'memoria_confirmar', { hecho_id: g.id })).toEqual({ confirmado: true });
    expect(await ejecutarHerramienta(ambito, 'memoria_corregir', { hecho_id: g.id, contenido: 'Le encantan las rosas de su jardín' })).toEqual({ corregido: true });
    expect(await ejecutarHerramienta(ambito, 'memoria_privado', { hecho_id: g.id, privado: true })).toEqual({ privado: true });
    const busqueda = (await ejecutarHerramienta(ambito, 'memoria_buscar', { consulta: 'rosas' })) as { hechos: Array<{ contenido: string; privado: boolean }> };
    expect(busqueda.hechos).toEqual([expect.objectContaining({ contenido: 'Le encantan las rosas de su jardín', privado: true })]);
    expect(await ejecutarHerramienta(ambito, 'memoria_olvidar', { hecho_id: g.id })).toEqual({ olvidado: true });
    expect(((await ejecutarHerramienta(ambito, 'memoria_buscar', { consulta: 'rosas' })) as { hechos: unknown[] }).hechos).toEqual([]);

    const auditoria = await e.owner.query<{ accion: string; detalle: unknown }>(`SELECT accion, detalle FROM registro_auditoria WHERE recurso_id = $1 ORDER BY id`, [g.id]);
    expect(auditoria.rows.map((r) => r.accion)).toEqual(['memoria.corregir', 'memoria.marcar_privado', 'memoria.olvidar']);
    expect(JSON.stringify(auditoria.rows)).not.toContain('rosas');
  });

  it('no puede tocar recuerdos de otra persona', async () => {
    const ajeno = await crearHecho(e.app.bd, e.app.cifrador, e.ids.personaAjena, { capa: 'biografica', contenido: 'Fue camionero', privado: false, estado: 'confirmado', fuente: 'persona' });
    for (const [h, entrada] of [
      ['memoria_corregir', { hecho_id: ajeno, contenido: 'Fue piloto' }],
      ['memoria_olvidar', { hecho_id: ajeno }],
      ['memoria_privado', { hecho_id: ajeno, privado: true }],
      ['memoria_confirmar', { hecho_id: ajeno }],
    ] as const) {
      expect(await ejecutarHerramienta(ambito, h, entrada)).toEqual({ error: 'No encontré ese recuerdo.' });
    }
    const r = await e.owner.query('SELECT 1 FROM hecho_memoria WHERE id = $1', [ajeno]);
    expect(r.rowCount).toBe(1);
  });

  it('rechaza entradas inválidas del modelo sin romper el bucle', async () => {
    expect(await ejecutarHerramienta(ambito, 'memoria_olvidar', { hecho_id: 'no-es-uuid' })).toMatchObject({ error: expect.stringContaining('Entrada inválida') });
    expect(await ejecutarHerramienta(ambito, 'memoria_inventada', {})).toMatchObject({ error: expect.stringContaining('desconocida') });
  });

  it('sin modelo de embeddings, la búsqueda episódica usa palabras', async () => {
    await e.owner.query('INSERT INTO embedding_memoria (persona_id, sesion_id, resumen_cifrado) VALUES ($1, $2, $3)', [
      e.ids.persona,
      sesionId,
      e.app.cifrador.cifrar('Conversaron sobre el control de la rodilla en el CESFAM.'),
    ]);
    const r = await buscarEpisodios(e.app.bd, e.app.cifrador, e.app.modelos, e.ids.persona, sesionId, '¿cómo le fue con la rodilla?');
    expect(r.metodo).toBe('palabras');
    expect(r.episodios[0]?.resumen).toContain('rodilla');
  });
});

describe('instrucciones con memoria', () => {
  const base = {
    perfil: PERFIL_POR_DEFECTO,
    nombrePersona: 'Rosa',
    preferencias: ['Le gusta que la traten de usted'],
    hechos: [{ contenido: 'Tiene diabetes', privado: true }, { contenido: 'Su nieta Camila vive en Temuco', privado: false }],
    porConfirmar: [{ id: 'abc', contenido: 'Su perro se llama Canela' }],
    episodios: [{ fecha: new Date('2026-11-10T15:00:00Z'), resumen: 'Habló de la feria.', temasPendientes: ['cómo le fue con la rodilla'] }],
    nivelRiesgo: 0 as const,
    categoriasRiesgo: [],
    modoEmergencia: false,
    ahora: new Date('2026-11-12T15:00:00Z'),
  };

  it('marca lo privado, lista lo por confirmar y da continuidad', () => {
    const t = construirInstrucciones({ ...base, plan: null });
    expect(t).toContain('- Tiene diabetes (privado)');
    expect(t).toContain('[abc] Su perro se llama Canela');
    expect(t).toContain('cómo le fue con la rodilla');
    expect(t).toContain('memoria_que_recuerdo');
  });

  it('nunca incluye la formulación ni la hipótesis clínica del plan', () => {
    const plan = esquemaPlan.parse({ formulacion: 'FORMULACION-SECRETA', hipotesis: 'HIPOTESIS-SECRETA', objetivos: ['Caminar'], no_mencionar: ['NO-MENCIONAR'] });
    const t = construirInstrucciones({ ...base, plan });
    expect(t).not.toContain('FORMULACION-SECRETA');
    expect(t).not.toContain('HIPOTESIS-SECRETA');
    expect(t).not.toContain('NO-MENCIONAR');
    expect(t).toContain('Caminar');
  });
});

describe('API de memoria', () => {
  let hechoId: string;
  beforeAll(async () => {
    hechoId = await crearHecho(e.app.bd, e.app.cifrador, e.ids.persona, { capa: 'relacional', contenido: 'Su hermana Inés vive en Osorno', privado: true, estado: 'por_confirmar', fuente: 'extraccion' });
  });

  it('la persona ve toda su memoria, incluso lo privado', async () => {
    const r = await pedir<{ hechos: Array<{ id: string; privado: boolean; porConfirmar: boolean }> }>(e.f, 'GET', '/api/mi-memoria', e.tokens.dispositivo);
    expect(r.datos.hechos.find((h) => h.id === hechoId)).toMatchObject({ privado: true, porConfirmar: true });
  });

  it('nadie más usa /api/mi-memoria, y el familiar nunca ve la memoria', async () => {
    for (const t of [e.tokens.familiar, e.tokens.supervisor, e.tokens.admin]) expect((await pedir(e.f, 'GET', '/api/mi-memoria', t)).estado).toBe(403);
    expect((await pedir(e.f, 'GET', `/api/personas/${e.ids.persona}/memoria`, e.tokens.familiar)).estado).toBe(403);
    expect((await pedir(e.f, 'GET', `/api/personas/${e.ids.persona}/memoria`, e.tokens.guardia)).estado).toBe(403);
    expect((await pedir(e.f, 'GET', `/api/personas/${e.ids.persona}/memoria`, e.tokens.supervisorAjeno)).estado).toBe(403);
  });

  it('el supervisor asignado la ve y queda en la auditoría', async () => {
    const r = await pedir<{ hechos: Array<{ id: string }> }>(e.f, 'GET', `/api/personas/${e.ids.persona}/memoria`, e.tokens.supervisor);
    expect(r.datos.hechos.some((h) => h.id === hechoId)).toBe(true);
    const a = await e.owner.query(`SELECT 1 FROM registro_auditoria WHERE accion = 'memoria.ver' AND persona_id = $1`, [e.ids.persona]);
    expect(a.rowCount).toBeGreaterThan(0);
  });

  it('corrige, confirma y desmarca privado; otra persona no puede', async () => {
    const url = `/api/mi-memoria/hechos/${hechoId}`;
    expect((await pedir(e.f, 'PATCH', url, e.tokens.dispositivoAjeno, { contenido: 'x x x' })).estado).toBe(404);
    expect((await pedir(e.f, 'PATCH', url, e.tokens.dispositivo, {})).estado).toBe(400);
    expect((await pedir(e.f, 'PATCH', url, e.tokens.dispositivo, { contenido: 'Su hermana Inés vive en Puerto Montt', privado: false })).estado).toBe(200);
    const r = await e.owner.query<{ estado: string; privado: boolean; contenido_cifrado: Buffer; corregido_en: Date | null }>('SELECT estado, privado, contenido_cifrado, corregido_en FROM hecho_memoria WHERE id = $1', [hechoId]);
    expect(r.rows[0]).toMatchObject({ estado: 'confirmado', privado: false });
    expect(r.rows[0]!.corregido_en).not.toBeNull();
    expect(e.app.cifrador.descifrar(r.rows[0]!.contenido_cifrado)).toBe('Su hermana Inés vive en Puerto Montt');
  });

  it('exporta toda la memoria y el perfil, con auditoría', async () => {
    const r = await e.f.inject({ method: 'GET', url: '/api/mi-memoria/exportar', headers: { authorization: `Bearer ${e.tokens.dispositivo}` } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toContain('mi-memoria-');
    const d = JSON.parse(r.body) as { formato: string; hechos: Array<{ contenido: string }> };
    expect(d.formato).toBe('vincular-ia/memoria/v1');
    expect(d.hechos.some((h) => h.contenido.includes('Puerto Montt'))).toBe(true);
  });

  it('olvidar un recuerdo y borrar todo (con frase de confirmación)', async () => {
    expect((await pedir(e.f, 'DELETE', `/api/mi-memoria/hechos/${hechoId}`, e.tokens.dispositivo)).estado).toBe(200);
    expect((await pedir(e.f, 'DELETE', `/api/mi-memoria/hechos/${hechoId}`, e.tokens.dispositivo)).estado).toBe(404);

    await crearHecho(e.app.bd, e.app.cifrador, e.ids.persona, { capa: 'preferencias', contenido: 'Le gusta el té con limón', privado: false, estado: 'confirmado', fuente: 'persona' });
    expect((await pedir(e.f, 'DELETE', '/api/mi-memoria', e.tokens.dispositivo, { confirmacion: 'si' })).estado).toBe(400);
    const r = await pedir<{ borrados: { hechos: number; episodios: number } }>(e.f, 'DELETE', '/api/mi-memoria', e.tokens.dispositivo, { confirmacion: 'borrar todo' });
    expect(r.estado).toBe(200);
    expect(r.datos.borrados.hechos).toBeGreaterThan(0);
    const quedan = await e.owner.query('SELECT (SELECT count(*) FROM hecho_memoria WHERE persona_id = $1)::int + (SELECT count(*) FROM embedding_memoria WHERE persona_id = $1)::int AS n', [e.ids.persona]);
    expect(quedan.rows[0].n).toBe(0);
    const ajena = await e.owner.query('SELECT count(*)::int AS n FROM hecho_memoria WHERE persona_id = $1', [e.ids.personaAjena]);
    expect(ajena.rows[0].n).toBeGreaterThan(0);
  });

  it('la persona diseña su compañero, sin romance ni humanidad fingida', async () => {
    expect((await pedir(e.f, 'PUT', '/api/mi-perfil-companero', e.tokens.dispositivo, { nombre: 'Pancho', personalidad: 'Quiero que seas mi pololo' })).estado).toBe(400);
    expect((await pedir(e.f, 'PUT', '/api/mi-perfil-companero', e.tokens.dispositivo, { nombre: 'Pancho', personalidad: 'Tranquilo y con humor', trato: 'tu', rol_preferente: 'amigo' })).estado).toBe(200);
    const r = await pedir<{ perfil: { nombre: string; trato: string } }>(e.f, 'GET', '/api/mi-perfil-companero', e.tokens.dispositivo);
    expect(r.datos.perfil).toMatchObject({ nombre: 'Pancho', trato: 'tu' });
    expect((await pedir(e.f, 'PUT', '/api/mi-perfil-companero', e.tokens.supervisor, { nombre: 'X' })).estado).toBe(403);
  });
});
