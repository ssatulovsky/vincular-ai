import type { ModelosPorTarea } from '@vincular/ia';
import { normalizar } from '@vincular/seguridad-clinica';
import type { Consultable } from '../db/conexion.ts';
import { incrustarTextos } from '../conversacion/llamadas.ts';
import type { Cifrador } from '../seguridad/cifrado.ts';
import { episodiosRecientes, type Episodio } from './hechos.ts';

/**
 * Búsqueda en la memoria episódica (resúmenes de conversaciones anteriores).
 * Con modelo de embeddings: búsqueda semántica en pgvector. Sin él (por ejemplo si todo corre
 * con Claude, que no ofrece embeddings) o si falla: búsqueda por palabras sobre los resúmenes.
 */
export async function buscarEpisodios(
  bd: Consultable,
  cifrador: Cifrador,
  modelos: ModelosPorTarea,
  personaId: string,
  sesionId: string | null,
  consulta: string,
  limite = 3,
): Promise<{ episodios: Episodio[]; metodo: 'semantica' | 'palabras' }> {
  try {
    const { vectores } = await incrustarTextos(bd, modelos, { personaId, sesionId }, [consulta], 'consulta');
    const r = await bd.query<{ id: string; sesion_id: string | null; creado_en: Date; resumen_cifrado: Buffer; temas_pendientes_cifrado: Buffer | null }>(
      `SELECT id, sesion_id, creado_en, resumen_cifrado, temas_pendientes_cifrado FROM embedding_memoria
        WHERE persona_id = $1 AND embedding IS NOT NULL
        ORDER BY embedding <=> $2::vector LIMIT $3`,
      [personaId, aLiteralVector(vectores[0]!), limite],
    );
    return {
      metodo: 'semantica',
      episodios: r.rows.map((f) => ({
        id: f.id,
        sesionId: f.sesion_id,
        fecha: f.creado_en,
        resumen: cifrador.descifrar(f.resumen_cifrado),
        temasPendientes: f.temas_pendientes_cifrado ? cifrador.descifrarJson<string[]>(f.temas_pendientes_cifrado) : [],
      })),
    };
  } catch {
    const palabras = normalizar(consulta).split(' ').filter((p) => p.length > 3);
    const todos = await episodiosRecientes(bd, cifrador, personaId, 200);
    const puntaje = (e: Episodio) => palabras.filter((p) => normalizar(e.resumen).includes(p)).length;
    return {
      metodo: 'palabras',
      episodios: todos
        .map((e) => ({ e, p: puntaje(e) }))
        .filter((x) => x.p > 0)
        .sort((a, b) => b.p - a.p)
        .slice(0, limite)
        .map((x) => x.e),
    };
  }
}

export function aLiteralVector(v: readonly number[]): string {
  return `[${v.join(',')}]`;
}
