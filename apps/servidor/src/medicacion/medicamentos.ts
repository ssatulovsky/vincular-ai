import { z } from 'zod';
import type { Consultable } from '../db/conexion.ts';
import type { Cifrador } from '../seguridad/cifrado.ts';

/**
 * Medicamentos de una persona. Los registra el equipo de salud (enfermera de enlace u otro
 * profesional asignado) tal como están indicados; el sistema nunca los modifica.
 */

const hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora en formato HH:MM');

export const esquemaMedicamento = z.object({
  nombre: z.string().trim().min(2).max(120),
  // En palabras de la persona: "para la presión".
  propositoSimple: z.string().trim().max(120).nullable().default(null),
  // Tal como está indicado: "1 comprimido", "media pastilla".
  dosisTexto: z.string().trim().min(1).max(120),
  horarios: z.array(hora).min(1).max(8).refine((h) => new Set(h).size === h.length, 'Horarios repetidos'),
});

export type DatosMedicamento = z.infer<typeof esquemaMedicamento>;

export interface Medicamento extends DatosMedicamento {
  id: string;
  vigente: boolean;
}

interface Fila {
  id: string;
  nombre_cifrado: Buffer;
  proposito_simple_cifrado: Buffer | null;
  dosis_texto_cifrado: Buffer;
  horarios: string[];
  vigente: boolean;
}

function aMedicamento(c: Cifrador, f: Fila): Medicamento {
  return {
    id: f.id,
    nombre: c.descifrar(f.nombre_cifrado),
    propositoSimple: f.proposito_simple_cifrado ? c.descifrar(f.proposito_simple_cifrado) : null,
    dosisTexto: c.descifrar(f.dosis_texto_cifrado),
    horarios: [...f.horarios].sort(),
    vigente: f.vigente,
  };
}

export async function listarMedicamentos(bd: Consultable, c: Cifrador, personaId: string, soloVigentes = true): Promise<Medicamento[]> {
  const r = await bd.query<Fila>(
    `SELECT id, nombre_cifrado, proposito_simple_cifrado, dosis_texto_cifrado, horarios, vigente FROM medicamento WHERE persona_id = $1 AND ($2 = false OR vigente) ORDER BY creado_en`,
    [personaId, soloVigentes],
  );
  return r.rows.map((f) => aMedicamento(c, f));
}

export async function crearMedicamento(bd: Consultable, c: Cifrador, personaId: string, d: DatosMedicamento, autorId: string | null): Promise<string> {
  const r = await bd.query<{ id: string }>(
    `INSERT INTO medicamento (persona_id, nombre_cifrado, proposito_simple_cifrado, dosis_texto_cifrado, horarios, creado_por) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [personaId, c.cifrar(d.nombre), d.propositoSimple ? c.cifrar(d.propositoSimple) : null, c.cifrar(d.dosisTexto), JSON.stringify(d.horarios), autorId],
  );
  return r.rows[0]!.id;
}

/**
 * Cambiar un medicamento anula las dosis futuras aún no recordadas: la agenda se regenera con
 * los datos nuevos. Las ya recordadas siguen su curso.
 */
export async function actualizarMedicamento(bd: Consultable, c: Cifrador, personaId: string, id: string, d: DatosMedicamento, ahora: Date): Promise<boolean> {
  const r = await bd.query(
    `UPDATE medicamento SET nombre_cifrado = $3, proposito_simple_cifrado = $4, dosis_texto_cifrado = $5, horarios = $6, actualizado_en = now()
     WHERE id = $1 AND persona_id = $2 AND vigente`,
    [id, personaId, c.cifrar(d.nombre), d.propositoSimple ? c.cifrar(d.propositoSimple) : null, c.cifrar(d.dosisTexto), JSON.stringify(d.horarios)],
  );
  if (!r.rowCount) return false;
  await anularFuturas(bd, id, ahora);
  return true;
}

export async function suspenderMedicamento(bd: Consultable, personaId: string, id: string, ahora: Date): Promise<boolean> {
  const r = await bd.query('UPDATE medicamento SET vigente = false, actualizado_en = now() WHERE id = $1 AND persona_id = $2 AND vigente', [id, personaId]);
  if (!r.rowCount) return false;
  await anularFuturas(bd, id, ahora);
  return true;
}

async function anularFuturas(bd: Consultable, medicamentoId: string, ahora: Date): Promise<void> {
  await bd.query(`UPDATE evento_dosis SET estado = 'anulada', cerrado_en = $2 WHERE medicamento_id = $1 AND estado = 'pendiente' AND programada_en > $2`, [medicamentoId, ahora]);
}
