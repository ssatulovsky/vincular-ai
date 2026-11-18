import { z } from 'zod';
import { extraerObjetoJson, ErrorProveedor, type ModelosPorTarea } from '@vincular/ia';
import { PATRON_DIAGNOSTICOS } from '@vincular/seguridad-clinica';
import type { Bd, Consultable } from '../db/conexion.ts';
import type { Cifrador } from '../seguridad/cifrado.ts';
import { llamarModelo } from '../conversacion/llamadas.ts';
import { planVigente } from '../conversacion/plan.ts';
import { turnosDeSesion } from '../conversacion/repositorio.ts';
import { CLAVES_LENTES, LENTES, lentesActivas, type Lente } from './lentes.ts';

/**
 * Resumen de sesión para el psicólogo supervisor (especificación, «Estructura del resumen de
 * sesión»): 10 puntos, cada uno separando lo OBSERVADO (lo que la persona dijo o hizo, con frases
 * textuales breves) de lo INFERIDO (interpretación tentativa del agente). Incluye las lentes
 * teóricas activas (decisión 0011).
 *
 * Contra alucinaciones, todo lo verifica el código antes de guardarlo como válido:
 *   - Cada cita existe literalmente en algo que la persona dijo en ESA sesión.
 *   - Lo inferido, las lecturas y las intervenciones no contienen diagnósticos; lo observado solo
 *     nombra un diagnóstico si la persona lo dijo (y se cita).
 *   - Una "lectura" de lente se apoya en al menos 2 sesiones previas que existen de verdad.
 *   - Fecha, duración, quién inició y nivel de riesgo los pone el código, no el modelo.
 * Si falla, se regenera una vez con los errores; si vuelve a fallar, queda como rechazado.
 */

export const MAX_INTENTOS_INFORME = 3;
const MAX_SESIONES_PREVIAS = 5;

// ── Esquema de lo que escribe el modelo ──────────────────────────────────────────────
const cita = z.string().trim().min(3).max(240);
const observacion = z.object({ texto: z.string().trim().min(3).max(600), citas: z.array(cita).max(4).default([]) });
const inferencia = z.object({ texto: z.string().trim().min(3).max(600), citas: z.array(cita).max(4).default([]) });
const seccion = z.object({ observado: z.array(observacion).max(8).default([]), inferido: z.array(inferencia).max(6).default([]) }).default({ observado: [], inferido: [] });

export const esquemaInformeModelo = z.object({
  temas: z.array(z.object({ tema: z.string().trim().min(2).max(200), minutos_aprox: z.number().min(0).max(600).nullable().default(null) })).max(15).default([]),
  estado_afectivo: seccion,
  pensamientos_creencias: seccion,
  funcionamiento_cotidiano: seccion,
  red_social: seccion,
  salud: seccion,
  riesgo: z.object({ justificacion: z.string().trim().min(3).max(800) }),
  intervenciones: z
    .array(z.object({ tipo: z.string().trim().min(2).max(80), descripcion: z.string().trim().min(3).max(500), respuesta_persona: z.string().trim().max(500).default(''), citas: z.array(cita).max(4).default([]) }))
    .max(10)
    .default([]),
  observaciones_supervisor: z
    .object({ hipotesis_tentativas: z.array(inferencia).max(6).default([]), temas_pendientes: z.array(z.string().trim().min(2).max(300)).max(8).default([]) })
    .default({ hipotesis_tentativas: [], temas_pendientes: [] }),
  // Indicadores para el informe semanal: solo si hay una cita de la persona que los sostenga.
  indicadores: z
    .object({
      animo: z.object({ valor: z.number().int().min(-2).max(2), cita: cita }).nullable().default(null),
      sueno: z.object({ valor: z.enum(['bueno', 'regular', 'malo']), cita: cita }).nullable().default(null),
      apetito: z.object({ valor: z.enum(['bueno', 'regular', 'malo']), cita: cita }).nullable().default(null),
      contactos_humanos: z
        .array(z.object({ tipo: z.enum(['llamada', 'visita', 'salida', 'mensaje', 'actividad']), con_quien: z.string().trim().max(80).default(''), cita: cita }))
        .max(10)
        .default([]),
    })
    .default({ animo: null, sueno: null, apetito: null, contactos_humanos: [] }),
  lentes: z
    .array(
      z.object({
        lente: z.string(),
        concepto: z.string().trim().min(2).max(120),
        senalamiento: z.string().trim().min(3).max(700),
        citas: z.array(cita).min(1).max(4),
        tipo: z.enum(['observacion', 'lectura']),
        sesiones_previas: z.array(z.string().uuid()).max(10).default([]),
      }),
    )
    .max(15)
    .default([]),
});
export type InformeModelo = z.infer<typeof esquemaInformeModelo>;

/** Lo que se guarda: lo del modelo, ya validado, más los datos que pone el código. */
export interface InformeSesion extends InformeModelo {
  version: 1;
  datos: { inicio: string; fin: string | null; duracionMin: number | null; iniciadaPor: string; canal: string; turnosPersona: number; turnosCompanero: number };
  nivelRiesgo: number;
  lentesActivas: Lente[];
}

// ── Validación ───────────────────────────────────────────────────────────────────────
/** Forma comparable: minúsculas, sin tildes, solo letras y números separados por un espacio. */
export function comparable(t: string): string {
  return t.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9ñ]+/g, ' ').trim();
}

export function diagnosticoEn(t: string): string | null {
  const m = comparable(t).match(PATRON_DIAGNOSTICOS);
  return m ? m[0] : null;
}

export interface ContextoValidacion {
  /** Lo que dijo la persona en esta sesión, turno por turno. */
  turnosPersona: readonly string[];
  /** Lo que dijo el compañero: solo para comillas dentro del texto (p. ej. al describir una intervención). */
  turnosCompanero?: readonly string[];
  lentesActivas: readonly Lente[];
  /** Sesiones previas que se le mostraron al modelo (las únicas que puede citar una lectura). */
  sesionesPrevias: ReadonlySet<string>;
}

export type ResultadoValidacion = { ok: true; informe: InformeModelo } | { ok: false; errores: string[]; informe: InformeModelo | null };

export function validarInforme(bruto: unknown, ctx: ContextoValidacion): ResultadoValidacion {
  const p = esquemaInformeModelo.safeParse(bruto);
  if (!p.success) return { ok: false, informe: null, errores: p.error.issues.slice(0, 8).map((i) => `Formato: ${i.path.join('.')}: ${i.message}`) };
  const inf = p.data;
  const errores: string[] = [];
  const turnos = ctx.turnosPersona.map(comparable);

  const verificarCitas = (donde: string, citas: readonly string[]) => {
    for (const c of citas) {
      const n = comparable(c);
      if (n.length < 3 || !turnos.some((t) => t.includes(n))) errores.push(`${donde}: la cita «${c.slice(0, 80)}» no está, tal cual, en lo que dijo la persona en esta sesión`);
    }
  };
  // Una cita entre comillas dentro de cualquier texto también tiene que existir en la conversación.
  const todos = [...turnos, ...(ctx.turnosCompanero ?? []).map(comparable)];
  const comillasEn = (donde: string, texto: string) => {
    for (const m of texto.matchAll(/«([^»]{3,})»|“([^”]{3,})”|"([^"]{3,})"/g)) {
      const n = comparable(m[1] ?? m[2] ?? m[3] ?? '');
      if (n.length >= 3 && !todos.some((t) => t.includes(n))) errores.push(`${donde}: el texto entre comillas «${(m[1] ?? m[2] ?? m[3] ?? '').slice(0, 80)}» no aparece en la conversación`);
    }
  };
  const sinDiagnostico = (donde: string, texto: string) => {
    comillasEn(donde, texto);
    const d = diagnosticoEn(texto);
    if (d) errores.push(`${donde}: contiene un diagnóstico («${d}»). Describa lo observado sin nombrar enfermedades ni trastornos`);
  };

  const SECCIONES = ['estado_afectivo', 'pensamientos_creencias', 'funcionamiento_cotidiano', 'red_social', 'salud'] as const;
  for (const s of SECCIONES) {
    inf[s].observado.forEach((o, i) => {
      verificarCitas(`${s}.observado[${i}]`, o.citas);
      comillasEn(`${s}.observado[${i}]`, o.texto);
      // Lo observado puede nombrar un diagnóstico solo si la persona lo dijo y se cita.
      const d = diagnosticoEn(o.texto);
      if (d && !o.citas.some((c) => comparable(c).includes(d))) errores.push(`${s}.observado[${i}]: nombra «${d}» sin una cita de la persona que lo diga`);
    });
    inf[s].inferido.forEach((x, i) => {
      verificarCitas(`${s}.inferido[${i}]`, x.citas);
      sinDiagnostico(`${s}.inferido[${i}]`, x.texto);
    });
  }
  inf.temas.forEach((t, i) => sinDiagnostico(`temas[${i}]`, t.tema));
  sinDiagnostico('riesgo.justificacion', inf.riesgo.justificacion);
  inf.intervenciones.forEach((x, i) => {
    verificarCitas(`intervenciones[${i}]`, x.citas);
    sinDiagnostico(`intervenciones[${i}]`, `${x.tipo} ${x.descripcion} ${x.respuesta_persona}`);
  });
  inf.observaciones_supervisor.hipotesis_tentativas.forEach((x, i) => {
    verificarCitas(`observaciones_supervisor.hipotesis_tentativas[${i}]`, x.citas);
    sinDiagnostico(`observaciones_supervisor.hipotesis_tentativas[${i}]`, x.texto);
  });
  inf.observaciones_supervisor.temas_pendientes.forEach((t, i) => sinDiagnostico(`observaciones_supervisor.temas_pendientes[${i}]`, t));

  const ind = inf.indicadores;
  for (const k of ['animo', 'sueno', 'apetito'] as const) if (ind[k]) verificarCitas(`indicadores.${k}`, [ind[k]!.cita]);
  ind.contactos_humanos.forEach((x, i) => verificarCitas(`indicadores.contactos_humanos[${i}]`, [x.cita]));

  inf.lentes.forEach((l, i) => {
    const donde = `lentes[${i}]`;
    if (!(CLAVES_LENTES as readonly string[]).includes(l.lente)) errores.push(`${donde}: la lente «${l.lente}» no existe`);
    else if (!ctx.lentesActivas.includes(l.lente as Lente)) errores.push(`${donde}: la lente «${l.lente}» está desactivada para este caso`);
    verificarCitas(donde, l.citas);
    sinDiagnostico(donde, `${l.concepto} ${l.senalamiento}`);
    // Una sola frase no basta: una lectura necesita recurrencia en sesiones anteriores reales.
    const previas = [...new Set(l.sesiones_previas)];
    const inexistentes = previas.filter((s) => !ctx.sesionesPrevias.has(s));
    if (inexistentes.length) errores.push(`${donde}: cita sesiones previas que no se le entregaron`);
    if (l.tipo === 'lectura' && previas.length - inexistentes.length < 2) errores.push(`${donde}: una lectura necesita al menos 2 sesiones previas que la sostengan; si no, márquela como observación`);
  });

  return errores.length ? { ok: false, errores, informe: inf } : { ok: true, informe: inf };
}

// ── Instrucciones ────────────────────────────────────────────────────────────────────
export function instruccionesInforme(lentes: readonly Lente[]): string {
  const listaLentes = lentes.map((l) => `- ${l}: ${LENTES[l].nombre}. ${LENTES[l].conceptos}`).join('\n');
  return `Eres el observador que redacta, para un psicólogo supervisor, el resumen escrito de una conversación entre una persona mayor que vive sola en Chile y su compañero conversacional con inteligencia artificial. El psicólogo evalúa y decide; tú observas y registras con rigor.

Reglas:
- Separa siempre lo OBSERVADO (lo que la persona dijo o hizo) de lo INFERIDO (tu interpretación, siempre tentativa: "posible", "a explorar", "podría").
- Las citas son frases textuales BREVES copiadas EXACTAMENTE de lo que dijo la PERSONA en esta sesión (nunca del compañero). Si no hay una frase que lo respalde, no cites.
- No diagnostiques ni nombres enfermedades o trastornos. Si la persona menciona uno suyo (por ejemplo "tengo diabetes"), regístralo en lo observado con su cita.
- No inventes: si una sección no tiene material, déjala vacía.
- Escribe en español de Chile, claro y sobrio, sin adjetivos innecesarios.

Puntos del resumen:
1. temas: en orden, con minutos aproximados (usa las horas de los turnos).
2. estado_afectivo: tono, energía, cambios durante la sesión.
3. pensamientos_creencias: por ejemplo "soy una carga", "nadie me llama".
4. funcionamiento_cotidiano: sueño, alimentación, actividad física, salidas.
5. red_social: contactos mencionados, conflictos, pérdidas, sugerencias de contacto aceptadas o rechazadas.
6. salud: adherencia a medicación, síntomas reportados, citas.
7. riesgo: justifica el nivel que el sistema asignó (te lo damos); no lo cambies.
8. intervenciones: lo que hizo el compañero (reminiscencia, activación conductual, validación, sugerir llamar a alguien…) y cómo respondió la persona.
9. observaciones_supervisor: hipótesis tentativas y temas para retomar la próxima vez.
10. indicadores (para seguir tendencias semana a semana), cada uno SOLO si una frase de la persona lo sostiene; si no, null:
   animo: -2 muy bajo, -1 bajo, 0 neutro, 1 bueno, 2 muy bueno. sueno y apetito: bueno, regular o malo.
   contactos_humanos: contactos con otras personas que ella cuenta haber tenido (llamada, visita, salida, mensaje, actividad), no los que planea.
11. lentes: lecturas teóricas para el profesional, solo con las lentes activas:
${listaLentes}
   Cada señalamiento nombra el concepto, se apoya en al menos una cita literal y es una hipótesis, nunca una conclusión.
   tipo "observacion": material de esta sesión. tipo "lectura": solo si el mismo patrón aparece en al menos 2 sesiones previas de las que te damos; indica sus ids en sesiones_previas.
   Si no hay material para una lente, omítela. La transferencia hacia el compañero se analiza siempre que haya material.

Responde SOLO con JSON con esta forma:
{"temas":[{"tema":"","minutos_aprox":0}],
 "estado_afectivo":{"observado":[{"texto":"","citas":[""]}],"inferido":[{"texto":"","citas":[]}]},
 "pensamientos_creencias":{...igual},"funcionamiento_cotidiano":{...igual},"red_social":{...igual},"salud":{...igual},
 "riesgo":{"justificacion":""},
 "intervenciones":[{"tipo":"","descripcion":"","respuesta_persona":"","citas":[]}],
 "observaciones_supervisor":{"hipotesis_tentativas":[{"texto":"","citas":[]}],"temas_pendientes":[""]},
 "indicadores":{"animo":{"valor":0,"cita":""},"sueno":null,"apetito":null,"contactos_humanos":[{"tipo":"llamada","con_quien":"","cita":""}]},
 "lentes":[{"lente":"<clave>","concepto":"","senalamiento":"","citas":[""],"tipo":"observacion","sesiones_previas":[]}]}`;
}

// ── Generación ───────────────────────────────────────────────────────────────────────
export interface DependenciasInforme {
  bd: Bd;
  cifrador: Cifrador;
  modelos: ModelosPorTarea;
}

export type ResultadoInforme =
  | { estado: 'valido' | 'rechazado'; errores?: string[] }
  | { estado: 'ya_existe' | 'sin_contenido' | 'ocupada' }
  | { estado: 'error'; error: string };

const hhmm = (d: Date) => d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Santiago' });

/** Notas de las últimas sesiones con informe válido: para que el modelo vea recurrencias. */
async function sesionesPrevias(bd: Consultable, cifrador: Cifrador, personaId: string, sesionId: string): Promise<Array<{ id: string; fecha: Date; notas: string }>> {
  const r = await bd.query<{ sesion_id: string; inicio: Date; contenido_cifrado: Buffer }>(
    `SELECT i.sesion_id, s.inicio, i.contenido_cifrado FROM informe_sesion i JOIN sesion_conversacion s ON s.id = i.sesion_id
      WHERE s.persona_id = $1 AND s.id <> $2 AND i.estado_validacion = 'valido' ORDER BY s.inicio DESC LIMIT $3`,
    [personaId, sesionId, MAX_SESIONES_PREVIAS],
  );
  return r.rows.map((f) => {
    const inf = cifrador.descifrarJson(f.contenido_cifrado) as InformeSesion;
    const lineas = [
      ...inf.pensamientos_creencias.observado.map((o) => `creencia: ${o.texto}${o.citas.length ? ` («${o.citas.join('», «')}»)` : ''}`),
      ...inf.estado_afectivo.observado.map((o) => `afecto: ${o.texto}`),
      ...inf.lentes.map((l) => `${l.lente} / ${l.concepto}: ${l.senalamiento}${l.citas.length ? ` («${l.citas.join('», «')}»)` : ''}`),
      ...inf.observaciones_supervisor.hipotesis_tentativas.map((h) => `hipótesis: ${h.texto}`),
    ];
    return { id: f.sesion_id, fecha: f.inicio, notas: lineas.slice(0, 20).join('\n') || '(sin notas)' };
  });
}

export async function generarInformeSesion(d: DependenciasInforme, sesionId: string, opciones: { forzar?: boolean } = {}): Promise<ResultadoInforme> {
  const c = await d.bd.connect();
  try {
    const bloqueo = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [`informe:${sesionId}`]);
    if (!bloqueo.rows[0]?.ok) return { estado: 'ocupada' };
    try {
      return await generarConBloqueo(d, c, sesionId, opciones.forzar ?? false);
    } finally {
      await c.query('SELECT pg_advisory_unlock(hashtext($1))', [`informe:${sesionId}`]);
    }
  } finally {
    c.release();
  }
}

async function generarConBloqueo(d: DependenciasInforme, c: Consultable, sesionId: string, forzar: boolean): Promise<ResultadoInforme> {
  const s = await c.query<{ persona_id: string; inicio: Date; fin: Date | null; ultimo_turno_en: Date | null; iniciada_por: string; canal: string; nivel_maximo: number; existe: string | null }>(
    `SELECT s.persona_id, s.inicio, s.fin, s.ultimo_turno_en, s.iniciada_por, s.canal, s.nivel_maximo, i.estado_validacion AS existe
       FROM sesion_conversacion s LEFT JOIN informe_sesion i ON i.sesion_id = s.id WHERE s.id = $1`,
    [sesionId],
  );
  const ses = s.rows[0];
  if (!ses) return { estado: 'error', error: 'sesión inexistente' };
  if (ses.existe === 'valido' || (ses.existe && !forzar)) return { estado: 'ya_existe' };

  const turnos = await turnosDeSesion(c, d.cifrador, sesionId, 10_000);
  const dePersona = turnos.filter((t) => t.hablante === 'persona');
  if (dePersona.length === 0) {
    await c.query('UPDATE sesion_conversacion SET informe_intentos = $2, informe_ultimo_error = $3 WHERE id = $1', [sesionId, MAX_INTENTOS_INFORME, 'sin turnos de la persona']);
    return { estado: 'sin_contenido' };
  }

  const plan = await planVigente(c, d.cifrador, ses.persona_id);
  const lentes = lentesActivas(plan?.contenido.lentes_desactivadas ?? []);
  const previas = await sesionesPrevias(c, d.cifrador, ses.persona_id, sesionId);
  const fin = ses.fin ?? ses.ultimo_turno_en;

  const transcripcion = turnos.map((t) => `[${hhmm(t.creadoEn)}] ${t.hablante === 'persona' ? 'PERSONA' : 'COMPAÑERO'}: ${t.texto}`).join('\n');
  const contexto = [
    `Nivel de riesgo que asignó el sistema en esta sesión: ${ses.nivel_maximo} (0 rutina, 1 atención, 2 alerta, 3 emergencia).`,
    plan
      ? `Del plan del supervisor (para reconocer intervenciones): objetivos: ${plan.contenido.objetivos.join('; ') || '—'}. Técnicas indicadas: ${plan.contenido.tecnicas_indicadas.join('; ') || '—'}.`
      : 'Todavía no hay plan terapéutico.',
    previas.length ? `Sesiones previas (las únicas que puede citar una lectura):\n${previas.map((p) => `## ${p.id} (${p.fecha.toISOString().slice(0, 10)})\n${p.notas}`).join('\n')}` : 'No hay sesiones previas con informe.',
  ].join('\n\n');

  const ctxValidacion: ContextoValidacion = { turnosPersona: dePersona.map((t) => t.texto), turnosCompanero: turnos.filter((t) => t.hablante === 'agente').map((t) => t.texto), lentesActivas: lentes, sesionesPrevias: new Set(previas.map((p) => p.id)) };
  const instrucciones = instruccionesInforme(lentes);
  let correccion = '';
  let ultimo: ResultadoValidacion | null = null;
  let modelo = '';
  try {
    for (let intento = 1; intento <= 2; intento++) {
      const r = await llamarModelo(c, d.modelos, 'informes', { personaId: ses.persona_id, sesionId }, {
        instrucciones,
        mensajes: [{ rol: 'usuario', texto: `${contexto}\n\nTranscripción:\n${transcripcion}${correccion}` }],
        respuestaJson: true,
        maxTokens: 5000,
        temperatura: 0.2,
      });
      modelo = d.modelos.para('informes').modelo;
      let bruto: unknown = null;
      try {
        bruto = r.tipo === 'texto' ? extraerObjetoJson(r.texto) : null;
      } catch {
        bruto = null;
      }
      ultimo = validarInforme(bruto, ctxValidacion);
      if (ultimo.ok) break;
      correccion = `\n\nTu respuesta anterior no pasó la validación. Corrige exactamente esto y responde el JSON completo:\n- ${ultimo.errores.join('\n- ')}`;
    }
  } catch (e) {
    const error = (e instanceof ErrorProveedor ? `${e.message}` : (e as Error).message).slice(0, 300);
    await c.query('UPDATE sesion_conversacion SET informe_intentos = informe_intentos + 1, informe_ultimo_error = $2 WHERE id = $1', [sesionId, error]);
    return { estado: 'error', error };
  }

  const base: Omit<InformeSesion, keyof InformeModelo> = {
    version: 1,
    datos: {
      inicio: ses.inicio.toISOString(),
      fin: fin ? fin.toISOString() : null,
      duracionMin: fin ? Math.max(0, Math.round((fin.getTime() - ses.inicio.getTime()) / 60000)) : null,
      iniciadaPor: ses.iniciada_por,
      canal: ses.canal,
      turnosPersona: dePersona.length,
      turnosCompanero: turnos.length - dePersona.length,
    },
    nivelRiesgo: ses.nivel_maximo,
    lentesActivas: lentes,
  };
  const valido = ultimo?.ok === true;
  const contenido = ultimo?.informe ? { ...ultimo.informe, ...base } : { ...base, sinContenidoValido: true };
  const errores = ultimo && !ultimo.ok ? ultimo.errores.slice(0, 20) : [];
  await c.query(
    `INSERT INTO informe_sesion (sesion_id, contenido_cifrado, estado_validacion, errores, lentes, modelo)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (sesion_id) DO UPDATE SET contenido_cifrado = EXCLUDED.contenido_cifrado, estado_validacion = EXCLUDED.estado_validacion,
       errores = EXCLUDED.errores, lentes = EXCLUDED.lentes, modelo = EXCLUDED.modelo, intentos = informe_sesion.intentos + 1, actualizado_en = now()`,
    [sesionId, d.cifrador.cifrarJson(contenido), valido ? 'valido' : 'rechazado', errores, lentes, modelo || null],
  );
  return valido ? { estado: 'valido' } : { estado: 'rechazado', errores };
}

/**
 * Sesiones listas para su informe: con la memoria ya procesada (o sea, terminadas) y sin informe.
 * Lo llama el planificador cada pocos minutos.
 */
export async function generarInformesPendientes(d: DependenciasInforme, limite = 10): Promise<ResultadoInforme[]> {
  const r = await d.bd.query<{ id: string }>(
    `SELECT s.id FROM sesion_conversacion s
      WHERE s.memoria_procesada_en IS NOT NULL AND s.informe_intentos < $1
        AND NOT EXISTS (SELECT 1 FROM informe_sesion i WHERE i.sesion_id = s.id)
      ORDER BY s.inicio LIMIT $2`,
    [MAX_INTENTOS_INFORME, limite],
  );
  const resultados: ResultadoInforme[] = [];
  for (const f of r.rows) resultados.push(await generarInformeSesion(d, f.id));
  return resultados;
}

export async function leerInforme(bd: Consultable, cifrador: Cifrador, sesionId: string) {
  const r = await bd.query<{ contenido_cifrado: Buffer; estado_validacion: string; errores: string[]; modelo: string | null; creado_en: Date; actualizado_en: Date }>(
    'SELECT contenido_cifrado, estado_validacion, errores, modelo, creado_en, actualizado_en FROM informe_sesion WHERE sesion_id = $1',
    [sesionId],
  );
  const f = r.rows[0];
  if (!f) return null;
  return { estado: f.estado_validacion, errores: f.errores, modelo: f.modelo, generadoEn: f.actualizado_en, contenido: cifrador.descifrarJson(f.contenido_cifrado) as InformeSesion };
}
