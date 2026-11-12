import { z } from 'zod';
import type { Consultable } from '../db/conexion.ts';
import { normalizarTelefono } from './telefonos.ts';

/**
 * Protocolos de escalamiento parametrizables: cada circunstancia (tipo de evento, nivel,
 * categoría, persona, días y horas) tiene su cadena de pasos y su plazo de acuse por paso.
 */

const canal = z.enum(['sms', 'llamada']);

export const esquemaPaso = z
  .object({
    destino: z.enum(['cuidadores', 'equipo_asignado', 'guardia', 'cuenta', 'telefono']),
    canales: z.array(canal).min(1).max(2).refine((c) => new Set(c).size === c.length, 'Canales repetidos'),
    /** Minutos a esperar un acuse antes del paso siguiente. 0 = el siguiente sale de inmediato (en paralelo). */
    esperarAcuseMin: z.number().int().min(0).max(1440),
    /** Solo cuidadores: permiso que la persona debe haberles dado. null = todos los cuidadores (riesgo vital). */
    permisoCuidador: z.enum(['alertas_riesgo', 'avisos_medicacion']).nullable().optional(),
    cuentaId: z.string().uuid().optional(),
    telefono: z.string().optional(),
  })
  .superRefine((p, ctx) => {
    if (p.destino === 'cuenta' && !p.cuentaId) ctx.addIssue({ code: 'custom', message: 'El destino "cuenta" necesita cuentaId' });
    if (p.destino === 'telefono' && !(p.telefono && normalizarTelefono(p.telefono))) ctx.addIssue({ code: 'custom', message: 'El destino "telefono" necesita un teléfono válido' });
  });

export type Paso = z.infer<typeof esquemaPaso>;

const hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const esquemaProtocolo = z
  .object({
    nombre: z.string().trim().min(3).max(120),
    tipoEvento: z.enum(['riesgo', 'dosis_sin_respuesta']),
    nivel: z.number().int().min(1).max(3).nullable().default(null),
    categoria: z.string().max(60).nullable().default(null),
    personaId: z.string().uuid().nullable().default(null),
    dias: z.array(z.number().int().min(1).max(7)).min(1).max(7).nullable().default(null),
    horaDesde: hora.nullable().default(null),
    horaHasta: hora.nullable().default(null),
    prioridad: z.number().int().min(-100).max(100).default(0),
    activo: z.boolean().default(true),
    pasos: z.array(esquemaPaso).min(1).max(12),
  })
  .superRefine((p, ctx) => {
    if ((p.horaDesde === null) !== (p.horaHasta === null)) ctx.addIssue({ code: 'custom', message: 'Indique hora de inicio y de término, o ninguna' });
    // Un aviso de riesgo nunca puede depender solo de la familia: la guardia debe estar en la cadena.
    if (p.tipoEvento === 'riesgo' && !p.pasos.some((x) => x.destino === 'guardia')) {
      ctx.addIssue({ code: 'custom', path: ['pasos'], message: 'Un protocolo de riesgo debe incluir a la guardia en algún paso' });
    }
    if (p.tipoEvento === 'riesgo' && (p.nivel ?? 3) >= 3 && p.pasos[0]!.esperarAcuseMin > 10) {
      ctx.addIssue({ code: 'custom', path: ['pasos'], message: 'En emergencia el primer paso no puede esperar más de 10 minutos' });
    }
  });

export type Protocolo = z.infer<typeof esquemaProtocolo>;

export interface ProtocoloElegido {
  id: string;
  nombre: string;
  pasos: Paso[];
}

/**
 * El protocolo que corresponde a un evento: entre los activos que calzan, el más específico
 * (persona, categoría, nivel, franja horaria) y luego el de mayor prioridad. La hora y el día se
 * evalúan en la zona horaria de la persona.
 */
export async function elegirProtocolo(
  bd: Consultable,
  p: { tipoEvento: string; nivel: number; categorias: readonly string[]; personaId: string; ahora: Date },
): Promise<ProtocoloElegido | null> {
  const r = await bd.query<{ id: string; nombre: string; pasos: unknown }>(
    `WITH local AS (SELECT ($5::timestamptz AT TIME ZONE zona_horaria) AS t FROM persona WHERE id = $4)
     SELECT pe.id, pe.nombre, pe.pasos
       FROM protocolo_escalamiento pe, local
      WHERE pe.activo AND pe.tipo_evento = $1
        AND (pe.nivel IS NULL OR pe.nivel = $2)
        AND (pe.categoria IS NULL OR pe.categoria = ANY($3::text[]))
        AND (pe.persona_id IS NULL OR pe.persona_id = $4)
        AND (pe.dias IS NULL OR extract(isodow FROM local.t)::smallint = ANY(pe.dias))
        AND (pe.hora_desde IS NULL OR
             CASE WHEN pe.hora_desde <= pe.hora_hasta THEN local.t::time BETWEEN pe.hora_desde AND pe.hora_hasta
                  ELSE local.t::time >= pe.hora_desde OR local.t::time <= pe.hora_hasta END)
      ORDER BY (pe.persona_id IS NOT NULL)::int * 8 + (pe.categoria IS NOT NULL)::int * 4 + (pe.nivel IS NOT NULL)::int * 2
               + (pe.dias IS NOT NULL OR pe.hora_desde IS NOT NULL)::int DESC,
               pe.prioridad DESC, pe.actualizado_en DESC
      LIMIT 1`,
    [p.tipoEvento, p.nivel, p.categorias, p.personaId, p.ahora],
  );
  const f = r.rows[0];
  if (!f) return null;
  return { id: f.id, nombre: f.nombre, pasos: z.array(esquemaPaso).parse(f.pasos) };
}

export async function guardarProtocolo(bd: Consultable, p: Protocolo, autorId: string | null, id?: string): Promise<string | null> {
  const valores = [p.nombre, p.tipoEvento, p.nivel, p.categoria, p.personaId, p.dias, p.horaDesde, p.horaHasta, p.prioridad, p.activo, JSON.stringify(p.pasos), autorId];
  if (id) {
    const r = await bd.query<{ id: string }>(
      `UPDATE protocolo_escalamiento SET nombre = $1, tipo_evento = $2, nivel = $3, categoria = $4, persona_id = $5, dias = $6, hora_desde = $7, hora_hasta = $8,
         prioridad = $9, activo = $10, pasos = $11, actualizado_por = $12, actualizado_en = now(), version = version + 1
       WHERE id = $13 RETURNING id`,
      [...valores, id],
    );
    return r.rows[0]?.id ?? null;
  }
  const r = await bd.query<{ id: string }>(
    `INSERT INTO protocolo_escalamiento (nombre, tipo_evento, nivel, categoria, persona_id, dias, hora_desde, hora_hasta, prioridad, activo, pasos, actualizado_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    valores,
  );
  return r.rows[0]!.id;
}

export async function listarProtocolos(bd: Consultable) {
  const r = await bd.query(
    `SELECT id, nombre, tipo_evento AS "tipoEvento", nivel, categoria, persona_id AS "personaId", dias, to_char(hora_desde, 'HH24:MI') AS "horaDesde",
            to_char(hora_hasta, 'HH24:MI') AS "horaHasta", prioridad, activo, pasos, version, actualizado_en AS "actualizadoEn"
       FROM protocolo_escalamiento ORDER BY tipo_evento, nivel NULLS LAST, prioridad DESC, nombre`,
  );
  return r.rows;
}
