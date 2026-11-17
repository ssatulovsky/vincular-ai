import { randomUUID } from 'node:crypto';
import { ErrorProveedor, type ModelosPorTarea } from '@vincular/ia';
import { z } from 'zod';
import type { Consultable } from '../db/conexion.ts';
import { registrarUso } from '../conversacion/llamadas.ts';

/**
 * Retratos del compañero (especificación: "el sistema genera 3 propuestas visuales; la persona
 * elige"). Son personas ficticias generadas con el modelo de imágenes de la tarea "imagenes".
 * El retrato elegido queda fijo: cambiar de cara seguido rompe el vínculo.
 */

export const esquemaPedidoAvatares = z.object({
  genero: z.enum(['femenina', 'masculina']),
  edad: z.enum(['joven', 'adulta', 'mayor']),
  entorno: z.enum(['cocina', 'jardin', 'living']),
});
export type PedidoAvatares = z.infer<typeof esquemaPedidoAvatares>;

export const PROPUESTAS_POR_RONDA = 3;
const MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 4 * 1024 * 1024;

const EDAD: Record<PedidoAvatares['edad'], string> = { joven: 'de unos 40 años', adulta: 'de unos 55 años', mayor: 'de unos 70 años' };
const ENTORNO: Record<PedidoAvatares['entorno'], string> = {
  cocina: 'una cocina hogareña chilena, luminosa y ordenada',
  jardin: 'un jardín con plantas y luz suave de tarde',
  living: 'un living acogedor, con un sillón y una lámpara encendida',
};
// Cada propuesta de la ronda varía en detalles, para que haya entre qué elegir.
const VARIANTES = [
  'cabello corto y ropa de colores suaves',
  'algunas canas y un chaleco de lana',
  'anteojos de marco delgado y una sonrisa leve',
] as const;

export function descripcionRetrato(p: PedidoAvatares, variante: number): string {
  const quien = p.genero === 'femenina' ? 'una mujer chilena' : 'un hombre chileno';
  return [
    `Retrato fotográfico realista, plano medio, de ${quien} ficticio ${EDAD[p.edad]}, con ${VARIANTES[variante % VARIANTES.length]}.`,
    `Mira a la cámara con una expresión cálida, serena y amable, en ${ENTORNO[p.entorno]}.`,
    'Luz natural suave, fondo levemente desenfocado, ropa sencilla y cotidiana.',
    'Es una persona inventada: no debe parecerse a ninguna persona real ni famosa.',
    'Sin texto, letras, logos ni marcas visibles. Imagen respetuosa y apta para todo público.',
  ].join(' ');
}

export class ErrorAvatares extends Error {
  constructor(
    readonly estado: number,
    mensaje: string,
  ) {
    super(mensaje);
  }
}

/** Rondas de generación de hoy (hora de Chile) para una persona. */
export async function rondasDeHoy(bd: Consultable, personaId: string): Promise<number> {
  const r = await bd.query<{ n: number }>(
    `SELECT count(DISTINCT ronda)::int AS n FROM avatar_propuesta
      WHERE persona_id = $1 AND (creado_en AT TIME ZONE 'America/Santiago')::date = (now() AT TIME ZONE 'America/Santiago')::date`,
    [personaId],
  );
  return r.rows[0]!.n;
}

/**
 * Genera una ronda de propuestas. Respeta el límite diario (costo) y guarda las que salgan bien:
 * si fallan todas, lanza ErrorAvatares 503 sin guardar nada.
 */
export async function generarRonda(
  d: { bd: Consultable; modelos: ModelosPorTarea; maxRondasDia: number },
  personaId: string,
  pedido: PedidoAvatares,
  creadoPor: 'persona' | 'personal',
): Promise<{ ronda: string; ids: string[]; fallidas: number }> {
  if ((await rondasDeHoy(d.bd, personaId)) >= d.maxRondasDia) {
    throw new ErrorAvatares(429, `Por hoy ya se crearon ${d.maxRondasDia} grupos de retratos. Puede elegir entre los que ya hay o seguir mañana.`);
  }
  let modelo;
  try {
    modelo = d.modelos.para('imagenes');
  } catch {
    throw new ErrorAvatares(503, 'La creación de retratos no está configurada (IA_MODELO_IMAGENES)');
  }
  if (!modelo.modelo) throw new ErrorAvatares(503, 'La creación de retratos no está configurada (IA_MODELO_IMAGENES)');

  const resultados = await Promise.allSettled(
    Array.from({ length: PROPUESTAS_POR_RONDA }, async (_, i) => {
      const inicio = performance.now();
      try {
        const r = await modelo.generarImagen({ descripcion: descripcionRetrato(pedido, i), proporcion: '1:1' });
        if (!MIMES.has(r.mime) || r.imagen.length === 0 || r.imagen.length > MAX_BYTES) throw new ErrorProveedor(modelo.proveedor, `Imagen inválida (${r.mime}, ${r.imagen.length} bytes)`);
        await registrarUso(d.bd, 'imagenes', modelo.proveedor, modelo.modelo, { personaId, sesionId: null }, Math.round(performance.now() - inicio), 0, 0, null);
        return r;
      } catch (e) {
        const detalle = e instanceof ErrorProveedor ? `${e.message}${e.estado ? ` (${e.estado})` : ''}${e.interno ? `: ${e.interno.replace(/\s+/g, ' ').slice(0, 300)}` : ''}` : (e as Error).message;
        await registrarUso(d.bd, 'imagenes', modelo.proveedor, modelo.modelo, { personaId, sesionId: null }, Math.round(performance.now() - inicio), 0, 0, detalle).catch(() => undefined);
        throw e;
      }
    }),
  );
  const buenas = resultados.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  if (buenas.length === 0) throw new ErrorAvatares(503, 'No se pudieron crear los retratos en este momento. Intente de nuevo en un rato.');

  const ronda = randomUUID();
  const ids: string[] = [];
  for (const b of buenas) {
    const r = await d.bd.query<{ id: string }>(
      `INSERT INTO avatar_propuesta (persona_id, ronda, genero, edad, entorno, imagen, mime, modelo, creado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [personaId, ronda, pedido.genero, pedido.edad, pedido.entorno, b.imagen, b.mime, modelo.modelo, creadoPor],
    );
    ids.push(r.rows[0]!.id);
  }
  return { ronda, ids, fallidas: resultados.length - buenas.length };
}

/** La imagen solo se entrega si la propuesta es de esa persona. */
export async function leerImagenAvatar(bd: Consultable, personaId: string, avatarId: string): Promise<{ imagen: Buffer; mime: string } | null> {
  if (!z.string().uuid().safeParse(avatarId).success) return null;
  const r = await bd.query<{ imagen: Buffer; mime: string }>('SELECT imagen, mime FROM avatar_propuesta WHERE id = $1 AND persona_id = $2', [avatarId, personaId]);
  return r.rows[0] ?? null;
}

/** Al guardar el perfil: el avatar elegido tiene que ser una propuesta de esa misma persona. */
export async function exigirAvatarPropio(bd: Consultable, personaId: string, avatarId: string | null): Promise<void> {
  if (avatarId === null) return;
  if (!z.string().uuid().safeParse(avatarId).success) throw new ErrorAvatares(400, 'Ese retrato no existe');
  const r = await bd.query('SELECT 1 FROM avatar_propuesta WHERE id = $1 AND persona_id = $2', [avatarId, personaId]);
  if (r.rowCount === 0) throw new ErrorAvatares(400, 'Ese retrato no existe');
}

/** Retratos recientes de la persona (los más nuevos primero), para volver a elegir entre ellos. */
export async function listarRetratos(bd: Consultable, personaId: string, limite = 12): Promise<Array<{ id: string; ronda: string; genero: string; edad: string; entorno: string; creadoEn: Date }>> {
  const r = await bd.query<{ id: string; ronda: string; genero: string; edad: string; entorno: string; creado_en: Date }>(
    'SELECT id, ronda, genero, edad, entorno, creado_en FROM avatar_propuesta WHERE persona_id = $1 ORDER BY creado_en DESC, id LIMIT $2',
    [personaId, limite],
  );
  return r.rows.map((x) => ({ id: x.id, ronda: x.ronda, genero: x.genero, edad: x.edad, entorno: x.entorno, creadoEn: x.creado_en }));
}
