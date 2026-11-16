import type { Bd, Consultable } from '../db/conexion.ts';
import { transaccion } from '../db/conexion.ts';
import type { Cifrador } from '../seguridad/cifrado.ts';
import { auditar } from '../seguridad/auditoria.ts';
import { listarMedicamentos, type Medicamento } from './medicamentos.ts';
import { textoRecordatorio } from './textos.ts';
import { iniciarEscalamiento } from '../escalamiento/motor.ts';

/**
 * Agenda de dosis y ciclo del recordatorio (especificación, Enfermero digital):
 *
 *   hora indicada        → recordatorio en la tablet (voz y pantalla)
 *   + segundoAvisoMin    → segundo aviso, si no confirmó
 *   + sinRespuestaMin    → "sin respuesta": señal de adherencia y aviso al cuidador
 *
 * Todo se decide en la base con la hora que recibe cada función (`ahora`): es idempotente,
 * funciona con varios procesos a la vez (FOR UPDATE SKIP LOCKED) y se prueba sin relojes falsos.
 *
 * TODO(clinico): plazos definitivos del segundo aviso y del aviso al cuidador.
 */

export interface PlazosMedicacion {
  segundoAvisoMin: number;
  sinRespuestaMin: number;
  /** Una dosis que nadie recordó a tiempo (servidor caído) no se escala pasado este plazo. */
  vencimientoMin: number;
}

export const PLAZOS_POR_DEFECTO: PlazosMedicacion = { segundoAvisoMin: 30, sinRespuestaMin: 30, vencimientoMin: 60 };

/** Crea los eventos de las próximas `horas` en la zona horaria de cada persona. Idempotente. */
export async function generarAgenda(bd: Consultable, ahora: Date, horas = 48, personaId: string | null = null): Promise<number> {
  const r = await bd.query(
    `INSERT INTO evento_dosis (medicamento_id, programada_en)
     SELECT m.id, x.instante
       FROM medicamento m
       JOIN persona p ON p.id = m.persona_id AND p.estado IN ('onboarding', 'activa')
       CROSS JOIN LATERAL jsonb_array_elements_text(m.horarios) AS h(hora)
       -- Días locales de la persona (ayer a pasado mañana): date + time = hora local, que
       -- AT TIME ZONE convierte al instante correcto, con o sin horario de verano.
       CROSS JOIN LATERAL generate_series(-1, ceil($2::int / 24.0)::int) AS k(dias)
       CROSS JOIN LATERAL (SELECT ((($1::timestamptz AT TIME ZONE p.zona_horaria)::date + k.dias) + h.hora::time) AT TIME ZONE p.zona_horaria AS instante) x
      WHERE m.vigente AND ($3::uuid IS NULL OR m.persona_id = $3)
        AND x.instante BETWEEN $1::timestamptz AND $1::timestamptz + make_interval(hours => $2::int)
     ON CONFLICT (medicamento_id, programada_en) DO UPDATE SET estado = 'pendiente', cerrado_en = NULL
       WHERE evento_dosis.estado = 'anulada'`,
    [ahora, horas, personaId],
  );
  return r.rowCount ?? 0;
}

export interface Recordatorio {
  personaId: string;
  programadaEn: Date;
  eventoIds: string[];
  texto: string;
  segundoAviso: boolean;
}

export interface EntregaTablet {
  /** Entrega un recordatorio a la tablet si está conectada. Devuelve si se entregó. */
  entregar(r: Recordatorio): Promise<boolean>;
}

interface FilaDosis {
  id: string;
  persona_id: string;
  medicamento_id: string;
  programada_en: Date;
}

async function datosPersona(bd: Consultable, c: Cifrador, personaId: string): Promise<{ nombre: string; trato: 'usted' | 'tu'; zona: string; medicamentos: Map<string, Medicamento> }> {
  const r = await bd.query<{ nombre_cifrado: Buffer; zona_horaria: string; trato: 'usted' | 'tu' | null }>(
    `SELECT p.nombre_cifrado, p.zona_horaria, pc.trato FROM persona p LEFT JOIN perfil_companero pc ON pc.persona_id = p.id WHERE p.id = $1`,
    [personaId],
  );
  const f = r.rows[0]!;
  const meds = await listarMedicamentos(bd, c, personaId, false);
  return { nombre: c.descifrar(f.nombre_cifrado).split(/\s+/)[0] ?? '', trato: f.trato ?? 'usted', zona: f.zona_horaria, medicamentos: new Map(meds.map((m) => [m.id, m])) };
}

export function horaLocal(d: Date, zona: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: zona, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

/** Agrupa las dosis de una persona a la misma hora en un solo recordatorio. */
async function armarRecordatorios(bd: Consultable, c: Cifrador, filas: FilaDosis[], segundoAviso: boolean): Promise<Recordatorio[]> {
  const grupos = new Map<string, FilaDosis[]>();
  for (const f of filas) {
    const k = `${f.persona_id}|${f.programada_en.toISOString()}`;
    (grupos.get(k) ?? grupos.set(k, []).get(k)!).push(f);
  }
  const salida: Recordatorio[] = [];
  for (const g of grupos.values()) {
    const p = await datosPersona(bd, c, g[0]!.persona_id);
    const meds = g.map((f) => p.medicamentos.get(f.medicamento_id)).filter((m): m is Medicamento => Boolean(m));
    salida.push({
      personaId: g[0]!.persona_id,
      programadaEn: g[0]!.programada_en,
      eventoIds: g.map((f) => f.id),
      segundoAviso,
      texto: textoRecordatorio({ nombrePersona: p.nombre, trato: p.trato, hora: horaLocal(g[0]!.programada_en, p.zona), medicamentos: meds, segundoAviso }),
    });
  }
  return salida;
}

export interface ResultadoCiclo {
  generadas: number;
  recordatorios: number;
  segundosAvisos: number;
  sinRespuesta: number;
  sinRegistro: number;
  notificaciones: number;
}

/**
 * Un paso del ciclo. Se llama cada pocos segundos desde el planificador del servidor (o desde
 * la CLI con cron). Las transiciones se hacen en la base antes de entregar: un recordatorio no
 * se repite aunque haya dos procesos.
 */
export async function cicloMedicacion(d: { bd: Bd; cifrador: Cifrador; entrega: EntregaTablet; plazos?: PlazosMedicacion }, ahora: Date): Promise<ResultadoCiclo> {
  const plazos = d.plazos ?? PLAZOS_POR_DEFECTO;
  const res: ResultadoCiclo = { generadas: await generarAgenda(d.bd, ahora), recordatorios: 0, segundosAvisos: 0, sinRespuesta: 0, sinRegistro: 0, notificaciones: 0 };

  // Dosis que nadie recordó a tiempo: no se escalan (no sabemos si se la tomó).
  const vencidas = await d.bd.query(
    `UPDATE evento_dosis SET estado = 'sin_registro', cerrado_en = $1 WHERE estado = 'pendiente' AND programada_en < $1::timestamptz - make_interval(mins => $2)`,
    [ahora, plazos.vencimientoMin],
  );
  res.sinRegistro = vencidas.rowCount ?? 0;

  const primeros = await transaccion(d.bd, async (c) => {
    const r = await c.query<FilaDosis>(
      `UPDATE evento_dosis e SET estado = 'recordada', recordado_en = $1
         FROM medicamento m
        WHERE e.id IN (SELECT id FROM evento_dosis WHERE estado = 'pendiente' AND programada_en <= $1 FOR UPDATE SKIP LOCKED)
          AND m.id = e.medicamento_id
        RETURNING e.id, m.persona_id, e.medicamento_id, e.programada_en`,
      [ahora],
    );
    return armarRecordatorios(c, d.cifrador, r.rows, false);
  });
  for (const r of primeros) await entregarYMarcar(d, r);
  res.recordatorios = primeros.length;

  const segundos = await transaccion(d.bd, async (c) => {
    const r = await c.query<FilaDosis>(
      `UPDATE evento_dosis e SET segundo_aviso_en = $1
         FROM medicamento m
        WHERE e.id IN (SELECT id FROM evento_dosis WHERE estado = 'recordada' AND segundo_aviso_en IS NULL
                          AND recordado_en <= $1::timestamptz - make_interval(mins => $2) FOR UPDATE SKIP LOCKED)
          AND m.id = e.medicamento_id
        RETURNING e.id, m.persona_id, e.medicamento_id, e.programada_en`,
      [ahora, plazos.segundoAvisoMin],
    );
    return armarRecordatorios(c, d.cifrador, r.rows, true);
  });
  for (const r of segundos) await entregarYMarcar(d, r);
  res.segundosAvisos = segundos.length;

  // Sin respuesta tras el segundo aviso: señal y aviso al cuidador (o al equipo).
  await transaccion(d.bd, async (c) => {
    const r = await c.query<{ id: string; persona_id: string; programada_en: Date; entregado_en_linea: boolean | null }>(
      `UPDATE evento_dosis e SET estado = 'sin_respuesta', cerrado_en = $1
         FROM medicamento m
        WHERE e.id IN (SELECT id FROM evento_dosis WHERE estado = 'recordada' AND segundo_aviso_en IS NOT NULL
                          AND segundo_aviso_en <= $1::timestamptz - make_interval(mins => $2) FOR UPDATE SKIP LOCKED)
          AND m.id = e.medicamento_id
        RETURNING e.id, m.persona_id, e.programada_en, e.entregado_en_linea`,
      [ahora, plazos.sinRespuestaMin],
    );
    res.sinRespuesta = r.rowCount ?? 0;
    const porGrupo = new Map<string, typeof r.rows>();
    for (const f of r.rows) {
      await c.query(`INSERT INTO senal (persona_id, tipo, valor, medido_en) VALUES ($1, 'adherencia.dosis_sin_respuesta', 1, $2)`, [f.persona_id, ahora]);
      const k = `${f.persona_id}|${f.programada_en.toISOString()}`;
      (porGrupo.get(k) ?? porGrupo.set(k, []).get(k)!).push(f);
    }
    for (const g of porGrupo.values()) res.notificaciones += await avisarSinRespuesta(c, g[0]!.persona_id, g[0]!.programada_en, g.map((x) => x.id), g.some((x) => x.entregado_en_linea === false), ahora);
  });
  return res;
}

async function entregarYMarcar(d: { bd: Bd; entrega: EntregaTablet }, r: Recordatorio): Promise<void> {
  let enLinea = false;
  try {
    enLinea = await d.entrega.entregar(r);
  } catch {
    enLinea = false;
  }
  // Solo se anota la primera entrega: si el primer aviso no llegó, el cuidador lo sabrá.
  await d.bd.query('UPDATE evento_dosis SET entregado_en_linea = coalesce(entregado_en_linea, false) OR $2 WHERE id = ANY($1)', [r.eventoIds, enLinea]);
}

/**
 * Aviso por una dosis sin respuesta: inicia la cadena de escalamiento del protocolo
 * "dosis_sin_respuesta" (por defecto, cuidadores autorizados y luego el equipo asignado).
 * El detalle no lleva nombres de medicamentos ni texto clínico.
 */
async function avisarSinRespuesta(c: Consultable, personaId: string, programadaEn: Date, eventoIds: string[], tabletSinConexion: boolean, ahora: Date): Promise<number> {
  const id = await iniciarEscalamiento(c, {
    personaId,
    tipoEvento: 'dosis_sin_respuesta',
    nivel: 1,
    categorias: ['dosis_sin_respuesta'],
    detalle: { programadaEn: programadaEn.toISOString(), dosis: eventoIds.length, tabletSinConexion },
    ahora,
  });
  return id ? 1 : 0;
}

export type OrigenConfirmacion = 'voz' | 'pantalla' | 'sin_conexion' | 'equipo';

/**
 * Confirma dosis de la persona. Sin ids, confirma las que están recordadas (o por recordar en la
 * próxima hora) más cercanas a `ahora`. Una confirmación después de "sin respuesta" se acepta y
 * queda marcada como tardía.
 */
export async function confirmarDosis(
  bd: Consultable,
  personaId: string,
  p: { eventoIds?: string[]; ahora: Date; tomadaEn?: Date; origen: OrigenConfirmacion },
): Promise<string[]> {
  const tomadaEn = p.tomadaEn && p.tomadaEn <= p.ahora ? p.tomadaEn : p.ahora;
  const r = await bd.query<{ id: string }>(
    `UPDATE evento_dosis e SET estado = 'confirmada', confirmada_en = $3, confirmacion_origen = $4,
            confirmada_tarde = (e.estado = 'sin_respuesta'), cerrado_en = $5
       FROM medicamento m
      WHERE m.id = e.medicamento_id AND m.persona_id = $1
        AND e.estado IN ('pendiente', 'recordada', 'sin_respuesta')
        AND e.programada_en BETWEEN $3::timestamptz - interval '6 hours' AND $3::timestamptz + interval '1 hour'
        AND (
          ($2::uuid[] IS NOT NULL AND e.id = ANY($2::uuid[]))
          OR ($2::uuid[] IS NULL AND e.programada_en = (
                SELECT e2.programada_en FROM evento_dosis e2 JOIN medicamento m2 ON m2.id = e2.medicamento_id
                 WHERE m2.persona_id = $1 AND e2.estado IN ('pendiente', 'recordada', 'sin_respuesta')
                   AND e2.programada_en BETWEEN $3::timestamptz - interval '6 hours' AND $3::timestamptz + interval '1 hour'
                 ORDER BY abs(extract(epoch FROM e2.programada_en - $3::timestamptz)) LIMIT 1))
        )
      RETURNING e.id`,
    [personaId, p.eventoIds?.length ? p.eventoIds : null, tomadaEn, p.origen, p.ahora],
  );
  return r.rows.map((x) => x.id);
}

/** La persona dice que no se la tomará o no se la tomó. Se registra, sin insistir. */
export async function registrarOmision(bd: Bd, c: Cifrador, personaId: string, p: { eventoIds: string[]; motivo: string | null; ahora: Date }): Promise<string[]> {
  return transaccion(bd, async (t) => {
    const r = await t.query<{ id: string }>(
      `UPDATE evento_dosis e SET estado = 'omitida', motivo_omision_cifrado = $3, cerrado_en = $4
         FROM medicamento m
        WHERE m.id = e.medicamento_id AND m.persona_id = $1 AND e.id = ANY($2::uuid[]) AND e.estado IN ('pendiente', 'recordada', 'sin_respuesta')
        RETURNING e.id`,
      [personaId, p.eventoIds, p.motivo ? c.cifrar(p.motivo) : null, p.ahora],
    );
    for (const _ of r.rows) await t.query(`INSERT INTO senal (persona_id, tipo, valor, medido_en) VALUES ($1, 'adherencia.dosis_omitida', 1, $2)`, [personaId, p.ahora]);
    if (r.rows.length) await auditar(t, { tipo: 'sistema' }, { accion: 'medicacion.omision', recursoTipo: 'evento_dosis', personaId, detalle: { dosis: r.rows.length } });
    return r.rows.map((x) => x.id);
  });
}

export interface DosisDelDia {
  eventoId: string;
  medicamentoId: string;
  nombre: string;
  propositoSimple: string | null;
  dosisTexto: string;
  hora: string;
  programadaEn: Date;
  estado: string;
}

/** Dosis entre `desde` y `hasta` (para el agente, la pantalla y la agenda sin conexión). */
export async function dosisEntre(bd: Consultable, c: Cifrador, personaId: string, desde: Date, hasta: Date): Promise<DosisDelDia[]> {
  const p = await datosPersona(bd, c, personaId);
  const r = await bd.query<{ id: string; medicamento_id: string; programada_en: Date; estado: string }>(
    `SELECT e.id, e.medicamento_id, e.programada_en, e.estado FROM evento_dosis e JOIN medicamento m ON m.id = e.medicamento_id
      WHERE m.persona_id = $1 AND e.programada_en BETWEEN $2 AND $3 AND e.estado <> 'anulada' ORDER BY e.programada_en`,
    [personaId, desde, hasta],
  );
  return r.rows
    .map((f) => {
      const m = p.medicamentos.get(f.medicamento_id);
      return m
        ? { eventoId: f.id, medicamentoId: m.id, nombre: m.nombre, propositoSimple: m.propositoSimple, dosisTexto: m.dosisTexto, hora: horaLocal(f.programada_en, p.zona), programadaEn: f.programada_en, estado: f.estado }
        : null;
    })
    .filter((x): x is DosisDelDia => x !== null);
}

/** Inicio y fin del día local de la persona que contiene `ahora`. */
export async function diaLocal(bd: Consultable, personaId: string, ahora: Date): Promise<{ desde: Date; hasta: Date }> {
  const r = await bd.query<{ desde: Date; hasta: Date }>(
    `SELECT (($2::timestamptz AT TIME ZONE zona_horaria)::date)::timestamp AT TIME ZONE zona_horaria AS desde,
            ((($2::timestamptz AT TIME ZONE zona_horaria)::date + 1)::timestamp AT TIME ZONE zona_horaria) - interval '1 second' AS hasta
       FROM persona WHERE id = $1`,
    [personaId, ahora],
  );
  return r.rows[0]!;
}

/** Recordatorios de las próximas horas, para que la tablet los haga sonar aunque se corte internet. */
export async function agendaSinConexion(bd: Consultable, c: Cifrador, personaId: string, ahora: Date, horas = 48): Promise<Array<{ programadaEn: string; eventoIds: string[]; texto: string; textoSegundoAviso: string }>> {
  await generarAgenda(bd, ahora, horas, personaId);
  const dosis = (await dosisEntre(bd, c, personaId, ahora, new Date(ahora.getTime() + horas * 3_600_000))).filter((x) => x.estado === 'pendiente' || x.estado === 'recordada');
  const p = await datosPersona(bd, c, personaId);
  const grupos = new Map<string, DosisDelDia[]>();
  for (const x of dosis) (grupos.get(x.programadaEn.toISOString()) ?? grupos.set(x.programadaEn.toISOString(), []).get(x.programadaEn.toISOString())!).push(x);
  return [...grupos.entries()].map(([iso, g]) => {
    const meds = g.map((x) => ({ nombre: x.nombre, propositoSimple: x.propositoSimple, dosisTexto: x.dosisTexto }));
    const base = { nombrePersona: p.nombre, trato: p.trato, hora: g[0]!.hora, medicamentos: meds };
    return { programadaEn: iso, eventoIds: g.map((x) => x.eventoId), texto: textoRecordatorio({ ...base, segundoAviso: false }), textoSegundoAviso: textoRecordatorio({ ...base, segundoAviso: true }) };
  });
}
