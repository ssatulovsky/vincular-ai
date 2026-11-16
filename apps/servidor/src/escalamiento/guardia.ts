import { z } from 'zod';
import type { Consultable } from '../db/conexion.ts';
import type { Cifrador } from '../seguridad/cifrado.ts';
import { HashTelefonos, normalizarTelefono } from './telefonos.ts';

/**
 * Turnos de guardia parametrizables: quién (una cuenta del personal o el teléfono de una
 * central externa), qué días y horas, en qué período y qué tipo de eventos cubre.
 */

const hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const esquemaTurno = z
  .object({
    nombre: z.string().trim().min(2).max(120),
    institucion: z.string().trim().max(120).nullable().default(null),
    cuentaId: z.string().uuid().nullable().default(null),
    telefono: z.string().nullable().default(null),
    dias: z.array(z.number().int().min(1).max(7)).min(1).max(7).default([1, 2, 3, 4, 5, 6, 7]),
    horaDesde: hora.default('00:00'),
    horaHasta: hora.default('23:59'),
    vigenteDesde: z.string().date().optional(),
    vigenteHasta: z.string().date().nullable().default(null),
    // "riesgo", "riesgo:3", "riesgo:2", "dosis_sin_respuesta"… Vacío = todo.
    cubre: z.array(z.string().regex(/^(riesgo|dosis_sin_respuesta)(:[1-3])?$/)).max(10).default([]),
    prioridad: z.number().int().min(-100).max(100).default(0),
    activo: z.boolean().default(true),
  })
  .superRefine((t, ctx) => {
    if (!t.cuentaId && !t.telefono) ctx.addIssue({ code: 'custom', message: 'Indique una cuenta del personal o un teléfono' });
    if (t.telefono && !normalizarTelefono(t.telefono)) ctx.addIssue({ code: 'custom', path: ['telefono'], message: 'Teléfono inválido (use +56…)' });
  });

export type DatosTurno = z.infer<typeof esquemaTurno>;

export async function guardarTurno(bd: Consultable, c: Cifrador, h: HashTelefonos, t: DatosTurno, id?: string): Promise<string | null> {
  const tel = t.telefono ? normalizarTelefono(t.telefono)! : null;
  const valores = [t.nombre, t.institucion, t.cuentaId, tel ? c.cifrar(tel) : null, tel ? h.hash(tel) : null, t.dias, t.horaDesde, t.horaHasta, t.vigenteDesde ?? new Date().toISOString().slice(0, 10), t.vigenteHasta, t.cubre, t.prioridad, t.activo];
  if (id) {
    const r = await bd.query<{ id: string }>(
      `UPDATE turno_guardia SET nombre = $1, institucion = $2, cuenta_id = $3, telefono_cifrado = $4, telefono_hash = $5, dias = $6, hora_desde = $7, hora_hasta = $8,
         vigente_desde = $9, vigente_hasta = $10, cubre = $11, prioridad = $12, activo = $13 WHERE id = $14 RETURNING id`,
      [...valores, id],
    );
    return r.rows[0]?.id ?? null;
  }
  const r = await bd.query<{ id: string }>(
    `INSERT INTO turno_guardia (nombre, institucion, cuenta_id, telefono_cifrado, telefono_hash, dias, hora_desde, hora_hasta, vigente_desde, vigente_hasta, cubre, prioridad, activo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
    valores,
  );
  return r.rows[0]!.id;
}

export interface DestinoGuardia {
  turnoId: string;
  nombre: string;
  cuentaId: string | null;
  telefono: string | null;
}

/**
 * Guardia de turno para un evento, en la zona horaria indicada (la de la persona). Si hay varios
 * turnos de la misma prioridad, se avisa a todos; los de menor prioridad son respaldo y no se
 * usan mientras haya uno de prioridad mayor.
 */
export async function guardiaDeTurno(bd: Consultable, c: Cifrador, p: { tipoEvento: string; nivel: number; ahora: Date; zona: string }): Promise<DestinoGuardia[]> {
  const r = await bd.query<{ id: string; nombre: string; cuenta_id: string | null; telefono_cifrado: Buffer | null; cuenta_tel: Buffer | null; prioridad: number }>(
    `WITH local AS (SELECT ($3::timestamptz AT TIME ZONE $4) AS t)
     SELECT tg.id, tg.nombre, tg.cuenta_id, tg.telefono_cifrado, cu.telefono_cifrado AS cuenta_tel, tg.prioridad
       FROM turno_guardia tg LEFT JOIN cuenta cu ON cu.id = tg.cuenta_id AND cu.activa, local
      WHERE tg.activo
        AND local.t::date BETWEEN tg.vigente_desde AND coalesce(tg.vigente_hasta, 'infinity'::date)
        AND extract(isodow FROM local.t)::smallint = ANY(tg.dias)
        AND CASE WHEN tg.hora_desde <= tg.hora_hasta THEN local.t::time BETWEEN tg.hora_desde AND tg.hora_hasta
                 ELSE local.t::time >= tg.hora_desde OR local.t::time <= tg.hora_hasta END
        AND (cardinality(tg.cubre) = 0 OR $1 = ANY(tg.cubre) OR ($1 || ':' || $2) = ANY(tg.cubre))
        AND (tg.cuenta_id IS NULL OR cu.id IS NOT NULL)
      ORDER BY tg.prioridad DESC`,
    [p.tipoEvento, p.nivel, p.ahora, p.zona],
  );
  const mejor = r.rows[0]?.prioridad;
  return r.rows
    .filter((f) => f.prioridad === mejor)
    .map((f) => {
      const cifrado = f.telefono_cifrado ?? f.cuenta_tel;
      return { turnoId: f.id, nombre: f.nombre, cuentaId: f.cuenta_id, telefono: cifrado ? c.descifrar(cifrado) : null };
    });
}
