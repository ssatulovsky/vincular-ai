import type { Bd, Consultable } from '../db/conexion.ts';
import { transaccion } from '../db/conexion.ts';
import type { Cifrador } from '../seguridad/cifrado.ts';

/**
 * Memoria estructurada de una persona. Todas las funciones reciben el `personaId` desde el
 * servidor (sesión de la tablet o permiso verificado), nunca desde el modelo: un hecho de otra
 * persona simplemente "no existe".
 */

export const CAPAS = ['biografica', 'relacional', 'preferencias', 'salud'] as const;
export type Capa = (typeof CAPAS)[number];
export type EstadoHecho = 'por_confirmar' | 'confirmado';
export type FuenteHecho = 'conversacion' | 'extraccion' | 'persona' | 'equipo';

export interface Hecho {
  id: string;
  capa: Capa;
  contenido: string;
  privado: boolean;
  estado: EstadoHecho;
  fuente: FuenteHecho;
  actualizadoEn: Date;
}

interface FilaHecho {
  id: string;
  capa: Capa;
  contenido_cifrado: Buffer;
  privado: boolean;
  estado: EstadoHecho;
  fuente: FuenteHecho;
  actualizado_en: Date;
}

const COLUMNAS = 'id, capa, contenido_cifrado, privado, estado, fuente, actualizado_en';

function aHecho(c: Cifrador, f: FilaHecho): Hecho {
  return { id: f.id, capa: f.capa, contenido: c.descifrar(f.contenido_cifrado), privado: f.privado, estado: f.estado, fuente: f.fuente, actualizadoEn: f.actualizado_en };
}

export async function listarHechos(bd: Consultable, c: Cifrador, personaId: string, opciones: { incluirPrivados: boolean }): Promise<Hecho[]> {
  const r = await bd.query<FilaHecho>(
    `SELECT ${COLUMNAS} FROM hecho_memoria WHERE persona_id = $1 AND vigente AND ($2 OR NOT privado) ORDER BY capa, actualizado_en DESC`,
    [personaId, opciones.incluirPrivados],
  );
  return r.rows.map((f) => aHecho(c, f));
}

export async function crearHecho(
  bd: Consultable,
  c: Cifrador,
  personaId: string,
  h: { capa: Capa; contenido: string; privado: boolean; estado: EstadoHecho; fuente: FuenteHecho; origenTurnoId?: string | null; sesionOrigenId?: string | null; cita?: string | null },
): Promise<string> {
  const r = await bd.query<{ id: string }>(
    `INSERT INTO hecho_memoria (persona_id, capa, contenido_cifrado, privado, estado, fuente, origen_turno_id, sesion_origen_id, cita_cifrada)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [personaId, h.capa, c.cifrar(h.contenido), h.privado, h.estado, h.fuente, h.origenTurnoId ?? null, h.sesionOrigenId ?? null, h.cita ? c.cifrar(h.cita) : null],
  );
  return r.rows[0]!.id;
}

/** Corregir un hecho: lo que dice la persona prevalece y queda confirmado. */
export async function corregirHecho(bd: Consultable, c: Cifrador, personaId: string, id: string, contenido: string, fuente: FuenteHecho = 'persona'): Promise<boolean> {
  const r = await bd.query(
    `UPDATE hecho_memoria SET contenido_cifrado = $3, estado = 'confirmado', fuente = $4, corregido_en = now(), actualizado_en = now()
     WHERE id = $1 AND persona_id = $2 AND vigente`,
    [id, personaId, c.cifrar(contenido), fuente],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function confirmarHecho(bd: Consultable, personaId: string, id: string): Promise<boolean> {
  const r = await bd.query(`UPDATE hecho_memoria SET estado = 'confirmado', actualizado_en = now() WHERE id = $1 AND persona_id = $2 AND vigente`, [id, personaId]);
  return (r.rowCount ?? 0) > 0;
}

export async function marcarPrivado(bd: Consultable, personaId: string, id: string, privado: boolean): Promise<boolean> {
  const r = await bd.query('UPDATE hecho_memoria SET privado = $3, actualizado_en = now() WHERE id = $1 AND persona_id = $2 AND vigente', [id, personaId, privado]);
  return (r.rowCount ?? 0) > 0;
}

/** Olvidar es borrar: el hecho deja de existir (la transcripción clínica no se toca). */
export async function olvidarHecho(bd: Consultable, personaId: string, id: string): Promise<boolean> {
  const r = await bd.query('DELETE FROM hecho_memoria WHERE id = $1 AND persona_id = $2', [id, personaId]);
  return (r.rowCount ?? 0) > 0;
}

export interface Episodio {
  id: string;
  sesionId: string | null;
  fecha: Date;
  resumen: string;
  temasPendientes: string[];
}

export async function episodiosRecientes(bd: Consultable, c: Cifrador, personaId: string, limite: number): Promise<Episodio[]> {
  const r = await bd.query<{ id: string; sesion_id: string | null; creado_en: Date; resumen_cifrado: Buffer; temas_pendientes_cifrado: Buffer | null }>(
    'SELECT id, sesion_id, creado_en, resumen_cifrado, temas_pendientes_cifrado FROM embedding_memoria WHERE persona_id = $1 ORDER BY creado_en DESC LIMIT $2',
    [personaId, limite],
  );
  return r.rows.map((f) => ({
    id: f.id,
    sesionId: f.sesion_id,
    fecha: f.creado_en,
    resumen: c.descifrar(f.resumen_cifrado),
    temasPendientes: f.temas_pendientes_cifrado ? c.descifrarJson<string[]>(f.temas_pendientes_cifrado) : [],
  }));
}

/** Exportación (derecho de acceso y portabilidad): toda la memoria y el perfil del compañero. */
export async function exportarMemoria(bd: Consultable, c: Cifrador, personaId: string) {
  const [hechos, episodios, perfil] = await Promise.all([
    listarHechos(bd, c, personaId, { incluirPrivados: true }),
    episodiosRecientes(bd, c, personaId, 10_000),
    bd.query('SELECT nombre, personalidad, forma_de_hablar, trato, voz_id, avatar_id, rol_preferente, velocidad_voz, actualizado_en FROM perfil_companero WHERE persona_id = $1', [personaId]),
  ]);
  return {
    formato: 'vincular-ia/memoria/v1',
    exportadoEn: new Date().toISOString(),
    perfilCompanero: perfil.rows[0] ?? null,
    hechos: hechos.map((h) => ({ capa: h.capa, contenido: h.contenido, privado: h.privado, estado: h.estado, fuente: h.fuente, actualizadoEn: h.actualizadoEn })),
    conversaciones: episodios.map((e) => ({ fecha: e.fecha, resumen: e.resumen, temasPendientes: e.temasPendientes })),
  };
}

/** Borra toda la memoria (hechos y memoria episódica). Devuelve cuántos registros se borraron. */
export async function borrarMemoria(bd: Bd, personaId: string): Promise<{ hechos: number; episodios: number }> {
  return transaccion(bd, async (t) => {
    const h = await t.query('DELETE FROM hecho_memoria WHERE persona_id = $1', [personaId]);
    const e = await t.query('DELETE FROM embedding_memoria WHERE persona_id = $1', [personaId]);
    return { hechos: h.rowCount ?? 0, episodios: e.rowCount ?? 0 };
  });
}
