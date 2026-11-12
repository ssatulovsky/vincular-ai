import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const CARPETA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/migraciones');

/**
 * Aplica en orden las migraciones pendientes, cada una en su transacción. Una migración ya
 * aplicada no se edita: si su contenido cambió, se detiene.
 */
export async function migrar(url: string, carpeta = CARPETA): Promise<{ aplicadas: string[]; yaAplicadas: number }> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS migraciones_aplicadas (
      nombre text PRIMARY KEY, checksum text NOT NULL, aplicada_en timestamptz NOT NULL DEFAULT now())`);
    await c.query('SELECT pg_advisory_lock(hashtext($1))', ['migraciones_vincular']);
    const { rows } = await c.query<{ nombre: string; checksum: string }>('SELECT nombre, checksum FROM migraciones_aplicadas');
    const previas = new Map(rows.map((r) => [r.nombre, r.checksum]));
    const archivos = (await readdir(carpeta)).filter((a) => /^\d{4}_.+\.sql$/.test(a)).sort();
    const aplicadas: string[] = [];
    let yaAplicadas = 0;
    for (const a of archivos) {
      const sql = await readFile(path.join(carpeta, a), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previo = previas.get(a);
      if (previo) {
        if (previo !== checksum) throw new Error(`La migración ${a} cambió después de aplicarse. Cree una migración nueva.`);
        yaAplicadas++;
        continue;
      }
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO migraciones_aplicadas (nombre, checksum) VALUES ($1, $2)', [a, checksum]);
        await c.query('COMMIT');
        aplicadas.push(a);
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`Falló la migración ${a}: ${(e as Error).message}`, { cause: e });
      }
    }
    return { aplicadas, yaAplicadas };
  } finally {
    await c.query('SELECT pg_advisory_unlock(hashtext($1))', ['migraciones_vincular']).catch(() => undefined);
    await c.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env.DATABASE_URL_MIGRACIONES;
  if (!url) {
    console.error('Falta DATABASE_URL_MIGRACIONES (conexión con el rol vincular_owner).');
    process.exit(1);
  }
  migrar(url)
    .then((r) => console.log(`Aplicadas: ${r.aplicadas.join(', ') || 'ninguna'} · ya estaban: ${r.yaAplicadas}`))
    .catch((e: Error) => {
      console.error(e.message);
      process.exit(1);
    });
}
