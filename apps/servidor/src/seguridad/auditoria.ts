import type { Consultable } from '../db/conexion.ts';
import type { Actor } from './permisos.ts';

export interface EntradaAuditoria {
  accion: string;
  recursoTipo: string;
  recursoId?: string | null;
  personaId?: string | null;
  motivo?: string | null;
  detalle?: Record<string, unknown>;
}

/** Registro de auditoría: inmutable en la base (trigger). Nunca guarda texto clínico. */
export async function auditar(bd: Consultable, actor: Actor | { tipo: 'sistema' }, e: EntradaAuditoria): Promise<void> {
  await bd.query(
    `INSERT INTO registro_auditoria (actor_tipo, actor_id, accion, recurso_tipo, recurso_id, persona_id, motivo, detalle)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [actor.tipo, 'id' in actor ? actor.id : null, e.accion, e.recursoTipo, e.recursoId ?? null, e.personaId ?? null, e.motivo ?? null, e.detalle ?? {}],
  );
}
