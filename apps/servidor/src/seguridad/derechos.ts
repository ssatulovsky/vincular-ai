import type { Consultable } from '../db/conexion.ts';
import type { Cifrador } from './cifrado.ts';

/**
 * Derecho de acceso y portabilidad (Ley 21.719): todos los datos de una persona en un JSON legible.
 *
 * Es genérico a propósito: recorre toda tabla con columna `persona_id` (y las que cuelgan de sus
 * sesiones por `sesion_id`), así una tabla nueva queda incluida sin tocar este código. Descifra los
 * campos cifrados; omite credenciales, hashes y binarios (imágenes, audio, embeddings), indicando
 * que se omitieron.
 */

const COLUMNA_OMITIDA = /(hash|token|secreto|contrasena|clave)/i;
const TABLAS_OMITIDAS = new Set(['migraciones_aplicadas']);

export interface Exportacion {
  generadoEn: string;
  personaId: string;
  aviso: string;
  tablas: Record<string, Array<Record<string, unknown>>>;
  omitidos: string[];
}

export async function exportarTodo(bd: Consultable, c: Cifrador, personaId: string): Promise<Exportacion | null> {
  const existe = await bd.query('SELECT 1 FROM persona WHERE id = $1', [personaId]);
  if (!existe.rowCount) return null;

  const cols = await bd.query<{ tabla: string; columna: string; tipo: string }>(
    `SELECT table_name AS tabla, column_name AS columna, data_type AS tipo
       FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
  );
  const porTabla = new Map<string, Array<{ columna: string; tipo: string }>>();
  for (const x of cols.rows) {
    if (TABLAS_OMITIDAS.has(x.tabla)) continue;
    if (!porTabla.has(x.tabla)) porTabla.set(x.tabla, []);
    porTabla.get(x.tabla)!.push(x);
  }

  const salida: Exportacion = {
    generadoEn: new Date().toISOString(),
    personaId,
    aviso: 'Datos personales y de salud de la persona, exportados por solicitud de acceso o portabilidad. Contiene información sensible: trátela con reserva.',
    tablas: {},
    omitidos: [],
  };

  const leer = async (tabla: string, filtro: string, valor: unknown) => {
    const columnas = porTabla.get(tabla)!;
    const r = await bd.query<Record<string, unknown>>(`SELECT * FROM "${tabla}" WHERE ${filtro}`, [valor]);
    if (r.rows.length === 0) return;
    salida.tablas[tabla] = r.rows.map((fila) => {
      const limpia: Record<string, unknown> = {};
      for (const { columna, tipo } of columnas) {
        const v = fila[columna];
        if (COLUMNA_OMITIDA.test(columna)) {
          if (v !== null) salida.omitidos.push(`${tabla}.${columna} (credencial o hash)`);
          continue;
        }
        if (tipo === 'bytea' && Buffer.isBuffer(v)) {
          if (/cifrad/.test(columna)) {
            try {
              limpia[columna.replace(/_cifrad[oa]s?$/, '')] = c.descifrar(v);
            } catch {
              salida.omitidos.push(`${tabla}.${columna} (no se pudo descifrar)`);
            }
          } else salida.omitidos.push(`${tabla}.${columna} (binario: imagen o audio)`);
          continue;
        }
        if (tipo === 'USER-DEFINED' && typeof v === 'string' && v.startsWith('[')) {
          salida.omitidos.push(`${tabla}.${columna} (vector de búsqueda)`);
          continue;
        }
        limpia[columna] = v;
      }
      return limpia;
    });
  };

  await leer('persona', 'id = $1', personaId);
  for (const [tabla, columnas] of porTabla) {
    if (tabla === 'persona') continue;
    const nombres = columnas.map((x) => x.columna);
    try {
      if (nombres.includes('persona_id')) await leer(tabla, 'persona_id = $1', personaId);
      else if (nombres.includes('sesion_id')) await leer(tabla, 'sesion_id IN (SELECT id FROM sesion_conversacion WHERE persona_id = $1)', personaId);
    } catch {
      salida.omitidos.push(`${tabla} (sin acceso)`);
    }
  }
  salida.omitidos = [...new Set(salida.omitidos)];
  return salida;
}
