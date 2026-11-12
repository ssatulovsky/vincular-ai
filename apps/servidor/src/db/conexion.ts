import pg from 'pg';

export type Cliente = pg.PoolClient;
export type Bd = pg.Pool;

export function crearPool(url: string): Bd {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  pool.on('error', (e) => console.error('[bd] error en una conexión inactiva:', e.message));
  return pool;
}

/** Ejecuta `fn` dentro de una transacción; deshace todo si lanza. */
export async function transaccion<T>(bd: Bd, fn: (c: Cliente) => Promise<T>): Promise<T> {
  const c = await bd.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Interfaz mínima común a Pool y PoolClient. */
export type Consultable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;
