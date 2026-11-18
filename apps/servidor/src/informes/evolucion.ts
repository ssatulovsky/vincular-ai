import { z } from 'zod';
import { extraerObjetoJson } from '@vincular/ia';
import type { Consultable } from '../db/conexion.ts';
import type { Cifrador } from '../seguridad/cifrado.ts';
import { llamarModelo } from '../conversacion/llamadas.ts';
import { comparable, diagnosticoEn, type DependenciasInforme, type InformeSesion } from './sesion.ts';

/**
 * Evolución semana a semana e informe semanal (especificación, «Informe semanal de evolución» y
 * «Medición de impacto»). Las cifras las calcula el código desde la base; la IA solo escribe una
 * síntesis breve que se valida como el resumen de sesión (citas literales, sin diagnósticos).
 *
 * Principio rector: el éxito se mide en menos soledad y más contacto humano, no en minutos de uso.
 * Si el uso sube mientras el contacto humano baja, es una señal de dependencia.
 */

const SEMANAS_MAX = 26;
export const SENAL_DEPENDENCIA = 'dependencia.uso_sube_contacto_baja';

export interface MetricasSemana {
  semana: string; // lunes, AAAA-MM-DD, en la zona horaria de la persona
  sesiones: number;
  minutos: number;
  iniciadasPorPersona: number;
  nivelMaximo: number;
  alertas: number;
  adherencia: { confirmadas: number; total: number; porcentaje: number | null };
  animo: { promedio: number | null; registros: number };
  suenoMalo: number;
  apetitoMalo: number;
  contactosHumanos: number;
  historiasRepetidas: number;
}

export interface LineaBase {
  desde: string;
  minutosSemana: number;
  contactosSemana: number;
  animoPromedio: number | null;
  adherencia: number | null;
}

export interface Evolucion {
  semanas: MetricasSemana[];
  lineaBase: LineaBase | null;
  dependencia: ResultadoDependencia;
}

export interface ResultadoDependencia {
  detectada: boolean;
  /** Por qué sí o por qué no (para el equipo clínico). */
  motivo: string;
}

const redondear = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/** Métricas por semana desde la primera sesión (hasta 26 semanas), en la zona horaria de la persona. */
export async function metricasPorSemana(bd: Consultable, cifrador: Cifrador, personaId: string, ahora = new Date()): Promise<MetricasSemana[]> {
  const z0 = await bd.query<{ zona: string; primera: Date | null }>(
    'SELECT p.zona_horaria AS zona, (SELECT min(inicio) FROM sesion_conversacion s WHERE s.persona_id = p.id) AS primera FROM persona p WHERE p.id = $1',
    [personaId],
  );
  const zona = z0.rows[0]?.zona ?? 'America/Santiago';
  const primera = z0.rows[0]?.primera;
  if (!primera) return [];

  const semanas = await bd.query<{ semana: string }>(
    `SELECT to_char(s, 'YYYY-MM-DD') AS semana FROM generate_series(
        greatest(date_trunc('week', $1::timestamptz AT TIME ZONE $2), date_trunc('week', $3::timestamptz AT TIME ZONE $2) - make_interval(weeks => $4)),
        date_trunc('week', $3::timestamptz AT TIME ZONE $2), interval '7 days') s`,
    [primera, zona, ahora, SEMANAS_MAX - 1],
  );
  const desde = semanas.rows[0]!.semana;
  const porSemana = new Map<string, MetricasSemana>(
    semanas.rows.map((r) => [
      r.semana,
      { semana: r.semana, sesiones: 0, minutos: 0, iniciadasPorPersona: 0, nivelMaximo: 0, alertas: 0, adherencia: { confirmadas: 0, total: 0, porcentaje: null }, animo: { promedio: null, registros: 0 }, suenoMalo: 0, apetitoMalo: 0, contactosHumanos: 0, historiasRepetidas: 0 },
    ]),
  );
  const semanaDe = `to_char(date_trunc('week', %s AT TIME ZONE $2), 'YYYY-MM-DD')`;
  const inicioRango = `(($3::date)::timestamp AT TIME ZONE $2)`;

  const [ses, alertas, dosis, historias, informes] = await Promise.all([
    bd.query<{ semana: string; sesiones: number; minutos: number; persona: number; nivel: number }>(
      `SELECT ${semanaDe.replace('%s', 'inicio')} AS semana, count(*)::int AS sesiones,
              coalesce(sum(least(extract(epoch FROM (coalesce(fin, ultimo_turno_en, inicio) - inicio)) / 60, 240)), 0)::float AS minutos,
              count(*) FILTER (WHERE iniciada_por = 'persona')::int AS persona, max(nivel_maximo)::int AS nivel
         FROM sesion_conversacion WHERE persona_id = $1 AND inicio >= ${inicioRango} GROUP BY 1`,
      [personaId, zona, desde],
    ),
    bd.query<{ semana: string; n: number }>(
      `SELECT ${semanaDe.replace('%s', 'creado_en')} AS semana, count(*)::int AS n FROM evento_riesgo WHERE persona_id = $1 AND nivel >= 2 AND creado_en >= ${inicioRango} GROUP BY 1`,
      [personaId, zona, desde],
    ),
    bd.query<{ semana: string; confirmadas: number; total: number }>(
      `SELECT ${semanaDe.replace('%s', 'e.programada_en')} AS semana,
              count(*) FILTER (WHERE e.estado = 'confirmada')::int AS confirmadas,
              count(*) FILTER (WHERE e.estado IN ('confirmada', 'omitida', 'sin_respuesta'))::int AS total
         FROM evento_dosis e JOIN medicamento m ON m.id = e.medicamento_id
        WHERE m.persona_id = $1 AND e.programada_en >= ${inicioRango} AND e.programada_en <= now() GROUP BY 1`,
      [personaId, zona, desde],
    ),
    bd.query<{ semana: string; n: number }>(
      `SELECT ${semanaDe.replace('%s', 'medido_en')} AS semana, count(*)::int AS n FROM senal WHERE persona_id = $1 AND tipo = 'memoria.historia_repetida' AND medido_en >= ${inicioRango} GROUP BY 1`,
      [personaId, zona, desde],
    ),
    bd.query<{ semana: string; contenido_cifrado: Buffer }>(
      `SELECT ${semanaDe.replace('%s', 's.inicio')} AS semana, i.contenido_cifrado
         FROM informe_sesion i JOIN sesion_conversacion s ON s.id = i.sesion_id
        WHERE s.persona_id = $1 AND i.estado_validacion = 'valido' AND s.inicio >= ${inicioRango}`,
      [personaId, zona, desde],
    ),
  ]);

  for (const r of ses.rows) {
    const m = porSemana.get(r.semana);
    if (m) Object.assign(m, { sesiones: r.sesiones, minutos: Math.round(r.minutos), iniciadasPorPersona: r.persona, nivelMaximo: r.nivel ?? 0 });
  }
  for (const r of alertas.rows) {
    const m = porSemana.get(r.semana);
    if (m) m.alertas = r.n;
  }
  for (const r of dosis.rows) {
    const m = porSemana.get(r.semana);
    if (m) m.adherencia = { confirmadas: r.confirmadas, total: r.total, porcentaje: r.total ? Math.round((r.confirmadas / r.total) * 100) : null };
  }
  for (const r of historias.rows) {
    const m = porSemana.get(r.semana);
    if (m) m.historiasRepetidas = r.n;
  }
  const animos = new Map<string, number[]>();
  for (const r of informes.rows) {
    const m = porSemana.get(r.semana);
    if (!m) continue;
    const ind = (cifrador.descifrarJson(r.contenido_cifrado) as InformeSesion).indicadores;
    if (!ind) continue;
    if (ind.animo) animos.set(r.semana, [...(animos.get(r.semana) ?? []), ind.animo.valor]);
    if (ind.sueno?.valor === 'malo') m.suenoMalo++;
    if (ind.apetito?.valor === 'malo') m.apetitoMalo++;
    m.contactosHumanos += ind.contactos_humanos?.length ?? 0;
  }
  for (const [s, vs] of animos) {
    const m = porSemana.get(s)!;
    m.animo = { promedio: redondear(vs.reduce((a, b) => a + b, 0) / vs.length), registros: vs.length };
  }
  return [...porSemana.values()];
}

/** Línea base: las dos primeras semanas con conversaciones. */
export function lineaBase(semanas: readonly MetricasSemana[]): LineaBase | null {
  const conDatos = semanas.filter((s) => s.sesiones > 0).slice(0, 2);
  if (!conDatos.length) return null;
  const prom = (xs: Array<number | null>) => {
    const v = xs.filter((x): x is number => x !== null);
    return v.length ? redondear(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  return {
    desde: conDatos[0]!.semana,
    minutosSemana: prom(conDatos.map((s) => s.minutos)) ?? 0,
    contactosSemana: prom(conDatos.map((s) => s.contactosHumanos)) ?? 0,
    animoPromedio: prom(conDatos.map((s) => s.animo.promedio)),
    adherencia: prom(conDatos.map((s) => s.adherencia.porcentaje)),
  };
}

/**
 * Señal de dependencia (especificación): el uso sube y el contacto humano baja durante 4 semanas.
 * Se comparan las 2 semanas completas más recientes con las 2 anteriores.
 * TODO(clinico): umbrales provisorios (uso +30 % y contacto −30 %); calibrar en el piloto.
 */
export function evaluarDependencia(semanasCompletas: readonly MetricasSemana[]): ResultadoDependencia {
  const u = semanasCompletas.slice(-4);
  if (u.length < 4) return { detectada: false, motivo: 'Faltan semanas completas para comparar (se necesitan 4).' };
  const suma = (xs: MetricasSemana[], k: 'minutos' | 'contactosHumanos') => xs.reduce((a, s) => a + s[k], 0);
  const [antes, despues] = [u.slice(0, 2), u.slice(2)];
  const usoAntes = suma(antes, 'minutos');
  const usoDespues = suma(despues, 'minutos');
  const contactoAntes = suma(antes, 'contactosHumanos');
  const contactoDespues = suma(despues, 'contactosHumanos');
  if (usoAntes === 0) return { detectada: false, motivo: 'Sin uso en las semanas de comparación.' };
  if (contactoAntes === 0) return { detectada: false, motivo: 'Sin contactos humanos registrados antes: no se puede medir una baja.' };
  const subeUso = usoDespues >= usoAntes * 1.3;
  const bajaContacto = contactoDespues <= contactoAntes * 0.7;
  const detalle = `Uso: ${usoAntes} → ${usoDespues} min; contactos humanos: ${contactoAntes} → ${contactoDespues} (dos semanas contra las dos anteriores).`;
  return subeUso && bajaContacto ? { detectada: true, motivo: `El uso sube y el contacto humano baja. ${detalle}` } : { detectada: false, motivo: detalle };
}

export async function evolucion(bd: Consultable, cifrador: Cifrador, personaId: string, ahora = new Date()): Promise<Evolucion> {
  const semanas = await metricasPorSemana(bd, cifrador, personaId, ahora);
  return { semanas, lineaBase: lineaBase(semanas), dependencia: evaluarDependencia(semanas.slice(0, -1)) };
}

/** ¿Se detectó dependencia en los últimos 7 días? El compañero refuerza entonces el puente social. */
export async function senalDependenciaReciente(bd: Consultable, personaId: string, ahora = new Date()): Promise<boolean> {
  const r = await bd.query('SELECT 1 FROM senal WHERE persona_id = $1 AND tipo = $2 AND medido_en > $3::timestamptz - interval \'7 days\' LIMIT 1', [personaId, SENAL_DEPENDENCIA, ahora]);
  return (r.rowCount ?? 0) > 0;
}

// ── Informe semanal ──────────────────────────────────────────────────────────────────
const esquemaSintesis = z.object({
  sintesis: z.string().trim().min(10).max(1500),
  cambios_relevantes: z.array(z.object({ texto: z.string().trim().min(3).max(500), citas: z.array(z.string().trim().min(3).max(240)).max(3).default([]) })).max(8).default([]),
  para_supervision: z.array(z.string().trim().min(3).max(300)).max(6).default([]),
});
export type SintesisSemanal = z.infer<typeof esquemaSintesis>;

/** Valida la síntesis: citas literales de la persona en esa semana, sin diagnósticos. */
export function validarSintesis(bruto: unknown, turnosPersona: readonly string[]): { ok: true; sintesis: SintesisSemanal } | { ok: false; errores: string[] } {
  const p = esquemaSintesis.safeParse(bruto);
  if (!p.success) return { ok: false, errores: p.error.issues.slice(0, 5).map((i) => `Formato: ${i.path.join('.')}: ${i.message}`) };
  const turnos = turnosPersona.map(comparable);
  const errores: string[] = [];
  const textos = [p.data.sintesis, ...p.data.cambios_relevantes.map((c) => c.texto), ...p.data.para_supervision];
  for (const t of textos) {
    const d = diagnosticoEn(t);
    if (d) errores.push(`Contiene un diagnóstico («${d}»)`);
    for (const m of t.matchAll(/«([^»]{3,})»|“([^”]{3,})”|"([^"]{3,})"/g)) {
      const n = comparable(m[1] ?? m[2] ?? m[3] ?? '');
      if (n.length >= 3 && !turnos.some((x) => x.includes(n))) errores.push(`El texto entre comillas «${(m[1] ?? m[2] ?? m[3] ?? '').slice(0, 60)}» no está en lo que dijo la persona esa semana`);
    }
  }
  for (const c of p.data.cambios_relevantes) {
    for (const x of c.citas) if (!turnos.some((t) => t.includes(comparable(x)))) errores.push(`La cita «${x.slice(0, 60)}» no está en lo que dijo la persona esa semana`);
  }
  return errores.length ? { ok: false, errores } : { ok: true, sintesis: p.data };
}

const INSTRUCCIONES_SEMANAL = `Redactas para un psicólogo supervisor la síntesis semanal de la evolución de una persona mayor que conversa con un compañero de inteligencia artificial. Te damos las cifras de la semana comparadas con su línea base y los resúmenes de sus conversaciones.
Reglas: describe tendencias y cambios relevantes con sobriedad; separa lo que la persona dijo de tus interpretaciones (tentativas); no diagnostiques ni nombres enfermedades o trastornos; las citas son frases textuales breves de la persona que aparecen en los resúmenes; si hay poco material, dilo. Recuerda el principio del servicio: lo que importa es menos soledad y más contacto humano, no más minutos de uso.
Responde SOLO con JSON: {"sintesis":"(máximo 6 frases)","cambios_relevantes":[{"texto":"","citas":[""]}],"para_supervision":["temas o preguntas para la próxima revisión"]}`;

export interface ContenidoSemanal {
  version: 1;
  semana: string;
  metricas: MetricasSemana;
  lineaBase: LineaBase | null;
  dependencia: ResultadoDependencia;
  sintesis: SintesisSemanal | null;
  erroresSintesis: string[];
}

/** Genera el informe de la semana completa anterior para cada persona que conversó esa semana. */
export async function generarInformesSemanales(d: DependenciasInforme, ahora = new Date()): Promise<Array<{ personaId: string; estado: string }>> {
  const r = await d.bd.query<{ persona_id: string; semana: string }>(
    `SELECT DISTINCT s.persona_id, to_char(date_trunc('week', $1::timestamptz AT TIME ZONE p.zona_horaria) - interval '7 days', 'YYYY-MM-DD') AS semana
       FROM sesion_conversacion s JOIN persona p ON p.id = s.persona_id
      WHERE p.estado <> 'baja'
        AND s.inicio >= (date_trunc('week', $1::timestamptz AT TIME ZONE p.zona_horaria) - interval '7 days') AT TIME ZONE p.zona_horaria
        AND s.inicio < date_trunc('week', $1::timestamptz AT TIME ZONE p.zona_horaria) AT TIME ZONE p.zona_horaria
        AND NOT EXISTS (SELECT 1 FROM informe_semanal w WHERE w.persona_id = s.persona_id
                         AND w.semana = (date_trunc('week', $1::timestamptz AT TIME ZONE p.zona_horaria) - interval '7 days')::date)
      LIMIT 20`,
    [ahora],
  );
  const res: Array<{ personaId: string; estado: string }> = [];
  for (const f of r.rows) res.push({ personaId: f.persona_id, estado: await generarInformeSemanal(d, f.persona_id, f.semana, ahora) });
  return res;
}

export async function generarInformeSemanal(d: DependenciasInforme, personaId: string, semana: string, ahora = new Date()): Promise<string> {
  const todas = await metricasPorSemana(d.bd, d.cifrador, personaId, ahora);
  const i = todas.findIndex((s) => s.semana === semana);
  if (i < 0) return 'sin_datos';
  const metricas = todas[i]!;
  const base = lineaBase(todas);
  const dependencia = evaluarDependencia(todas.slice(0, i + 1));
  if (dependencia.detectada) {
    await d.bd.query('INSERT INTO senal (persona_id, tipo, valor, medido_en) VALUES ($1, $2, 1, $3)', [personaId, SENAL_DEPENDENCIA, ahora]);
  }

  // Material de la semana: resúmenes válidos y lo que dijo la persona (para verificar citas).
  const z0 = await d.bd.query<{ zona: string }>('SELECT zona_horaria AS zona FROM persona WHERE id = $1', [personaId]);
  const zona = z0.rows[0]?.zona ?? 'America/Santiago';
  const rango = [personaId, zona, semana];
  const [informes, turnos] = await Promise.all([
    d.bd.query<{ inicio: Date; contenido_cifrado: Buffer }>(
      `SELECT s.inicio, i.contenido_cifrado FROM informe_sesion i JOIN sesion_conversacion s ON s.id = i.sesion_id
        WHERE s.persona_id = $1 AND i.estado_validacion = 'valido'
          AND s.inicio >= ($3::date)::timestamp AT TIME ZONE $2 AND s.inicio < ($3::date + 7)::timestamp AT TIME ZONE $2 ORDER BY s.inicio`,
      rango,
    ),
    d.bd.query<{ texto_cifrado: Buffer }>(
      `SELECT t.texto_cifrado FROM turno t JOIN sesion_conversacion s ON s.id = t.sesion_id
        WHERE s.persona_id = $1 AND t.hablante = 'persona'
          AND s.inicio >= ($3::date)::timestamp AT TIME ZONE $2 AND s.inicio < ($3::date + 7)::timestamp AT TIME ZONE $2`,
      rango,
    ),
  ]);
  const turnosPersona = turnos.rows.map((t) => d.cifrador.descifrar(t.texto_cifrado));

  let sintesis: SintesisSemanal | null = null;
  let erroresSintesis: string[] = [];
  if (informes.rows.length) {
    const resumenes = informes.rows
      .map((f) => {
        const x = d.cifrador.descifrarJson(f.contenido_cifrado) as InformeSesion;
        const obs = (['estado_afectivo', 'pensamientos_creencias', 'funcionamiento_cotidiano', 'red_social', 'salud'] as const).flatMap((k) =>
          x[k].observado.map((o) => `${k}: ${o.texto}${o.citas.length ? ` («${o.citas.join('», «')}»)` : ''}`),
        );
        return `## ${f.inicio.toISOString().slice(0, 10)}\n${obs.join('\n')}\nPendiente: ${x.observaciones_supervisor.temas_pendientes.join('; ') || '—'}`;
      })
      .join('\n\n');
    const cifras = JSON.stringify({ semana: metricas, lineaBase: base, dependencia });
    let correccion = '';
    try {
      for (let intento = 1; intento <= 2; intento++) {
        const r = await llamarModelo(d.bd, d.modelos, 'informes', { personaId, sesionId: null }, {
          instrucciones: INSTRUCCIONES_SEMANAL,
          mensajes: [{ rol: 'usuario', texto: `Cifras:\n${cifras}\n\nResúmenes de la semana:\n${resumenes}${correccion}` }],
          respuestaJson: true,
          maxTokens: 1500,
          temperatura: 0.2,
        });
        let bruto: unknown = null;
        try {
          bruto = r.tipo === 'texto' ? extraerObjetoJson(r.texto) : null;
        } catch {
          bruto = null;
        }
        const v = validarSintesis(bruto, turnosPersona);
        if (v.ok) {
          sintesis = v.sintesis;
          erroresSintesis = [];
          break;
        }
        erroresSintesis = v.errores;
        correccion = `\n\nTu respuesta anterior no pasó la validación. Corrige esto y responde el JSON completo:\n- ${v.errores.join('\n- ')}`;
      }
    } catch (e) {
      erroresSintesis = [`El modelo no respondió: ${(e as Error).message.slice(0, 200)}`];
    }
  } else {
    erroresSintesis = ['Sin resúmenes de sesión válidos esa semana: solo cifras.'];
  }

  const contenido: ContenidoSemanal = { version: 1, semana, metricas, lineaBase: base, dependencia, sintesis, erroresSintesis };
  await d.bd.query('INSERT INTO informe_semanal (persona_id, semana, contenido_cifrado) VALUES ($1, $2, $3) ON CONFLICT (persona_id, semana) DO NOTHING', [personaId, semana, d.cifrador.cifrarJson(contenido)]);
  return sintesis ? 'con_sintesis' : 'solo_cifras';
}

export async function informesSemanales(bd: Consultable, cifrador: Cifrador, personaId: string, limite = 12): Promise<ContenidoSemanal[]> {
  const r = await bd.query<{ contenido_cifrado: Buffer }>('SELECT contenido_cifrado FROM informe_semanal WHERE persona_id = $1 ORDER BY semana DESC LIMIT $2', [personaId, limite]);
  return r.rows.map((f) => cifrador.descifrarJson(f.contenido_cifrado) as ContenidoSemanal);
}

