import type { Consultable } from '../db/conexion.ts';

/**
 * Avatar animado en tiempo real (decisiones 0016 y 0017). El retrato que la persona eligió habla con
 * movimiento de boca y rostro, generado por un proveedor externo que recibe solo dos cosas:
 * el retrato (una persona ficticia) y el audio de lo que dice el compañero. La voz de la persona
 * nunca se le envía.
 *
 * Es un adorno con costo por minuto, nunca una dependencia: si no hay configuración, si se pasó
 * el tope diario, si hay una emergencia en curso o si el proveedor falla, la conversación sigue
 * igual con el retrato que respira.
 */

export type MotivoSinAvatar = 'sin_configuracion' | 'sin_retrato' | 'emergencia' | 'tope_diario';

interface TopesAvatar {
  maxMinutosDia: number;
  inactividadS: number;
}
export type ConfigAvatarAnimado =
  | ({ proveedor: 'lemonslice'; apiKey: string } & TopesAvatar)
  | ({ proveedor: 'simli'; apiKey: string; apiUrl: string; caraPrueba: string | null; zoom: number | null } & TopesAvatar);

/**
 * Regla pura: ¿se enciende el avatar en esta conversación?
 * En modo de emergencia no: menos piezas que puedan fallar mientras se activa la ayuda.
 */
export function decidirAvatar(e: {
  config: ConfigAvatarAnimado | null;
  avatarId: string | null;
  modoEmergencia: boolean;
  minutosHoy: number;
}): { usar: true } | { usar: false; motivo: MotivoSinAvatar } {
  if (!e.config) return { usar: false, motivo: 'sin_configuracion' };
  if (!e.avatarId) return { usar: false, motivo: 'sin_retrato' };
  if (e.modoEmergencia) return { usar: false, motivo: 'emergencia' };
  if (e.minutosHoy >= e.config.maxMinutosDia) return { usar: false, motivo: 'tope_diario' };
  return { usar: true };
}

/** Minutos de avatar que la persona lleva hoy (día de Chile), contando el que esté abierto. */
export async function minutosAvatarHoy(bd: Consultable, personaId: string): Promise<number> {
  const r = await bd.query<{ min: number }>(
    `SELECT coalesce(sum(extract(epoch FROM (coalesce(fin, now()) - inicio))), 0)::float8 / 60 AS min
       FROM uso_avatar
      WHERE persona_id = $1
        AND inicio >= (now() AT TIME ZONE 'America/Santiago')::date AT TIME ZONE 'America/Santiago'`,
    [personaId],
  );
  return r.rows[0]?.min ?? 0;
}

export async function abrirUsoAvatar(bd: Consultable, personaId: string, sesionId: string, proveedor: string): Promise<string> {
  const r = await bd.query<{ id: string }>('INSERT INTO uso_avatar (persona_id, sesion_id, proveedor) VALUES ($1, $2, $3) RETURNING id', [personaId, sesionId, proveedor]);
  return r.rows[0]!.id;
}

/** Cierra el registro una sola vez (el primer motivo es el que vale). */
export async function cerrarUsoAvatar(bd: Consultable, usoId: string, motivo: 'fin_sesion' | 'desconectado' | 'sin_video' | 'error_inicio', error?: string): Promise<void> {
  await bd.query('UPDATE uso_avatar SET fin = now(), motivo_fin = $2, error = $3 WHERE id = $1 AND fin IS NULL', [usoId, motivo, error ? error.replace(/\s+/g, ' ').slice(0, 300) : null]);
}

/** Minutos de avatar por persona en un mes 'AAAA-MM' (para el costo mensual). */
export async function minutosAvatarDelMes(bd: Consultable, mes: string): Promise<Array<{ personaId: string; proveedor: string; minutos: number }>> {
  const r = await bd.query<{ persona_id: string; proveedor: string; min: number }>(
    `SELECT persona_id, proveedor, sum(extract(epoch FROM (coalesce(fin, now()) - inicio)))::float8 / 60 AS min
       FROM uso_avatar
      WHERE inicio >= ($1 || '-01')::date AT TIME ZONE 'America/Santiago'
        AND inicio < (($1 || '-01')::date + interval '1 month') AT TIME ZONE 'America/Santiago'
      GROUP BY persona_id, proveedor`,
    [mes],
  );
  return r.rows.map((x) => ({ personaId: x.persona_id, proveedor: x.proveedor, minutos: x.min }));
}

/**
 * Indicaciones de movimiento para el proveedor (influyen solo en gestos y expresión, no en lo que
 * se dice). Tono adulto y sereno: nada de gestos exagerados ni coquetos.
 */
export const GESTOS_AL_HABLAR =
  'Habla con calma y calidez, como alguien de confianza conversando en su casa. Gestos suaves y pocos, mirada amable a la cámara, sonrisa leve cuando corresponde. Nada exagerado.';
export const GESTOS_AL_ESCUCHAR = 'Escucha con atención y paciencia: mirada a la cámara, asiente de vez en cuando, expresión tranquila y acogedora.';

/** Segundos que se espera a que el avatar aparezca con video antes de volver al retrato. */
export const ESPERA_VIDEO_AVATAR_S = 20;
