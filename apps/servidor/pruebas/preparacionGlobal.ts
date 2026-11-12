import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { migrar } from '../src/db/migrar.ts';

/**
 * Crea una base de datos de prueba nueva con los mismos roles que producción, aplica todas las
 * migraciones y la elimina al terminar. Las pruebas corren contra PostgreSQL real.
 *
 * Requiere PostgreSQL 16 con pgvector y un superusuario en TEST_PG_ADMIN_URL
 * (por defecto postgres://postgres:postgres_local@localhost:5432/postgres).
 */
declare module 'vitest' {
  export interface ProvidedContext {
    urlOwner: string;
    urlApp: string;
  }
}

function conBase(url: string, base: string, usuario?: string, clave?: string): string {
  const u = new URL(url);
  u.pathname = `/${base}`;
  if (usuario) u.username = usuario;
  if (clave !== undefined) u.password = clave;
  return u.toString();
}

export default async function preparar(project: TestProject): Promise<() => Promise<void>> {
  const admin = process.env.TEST_PG_ADMIN_URL ?? 'postgres://postgres:postgres_local@localhost:5432/postgres';
  const nombre = `vincular_prueba_${randomBytes(4).toString('hex')}`;
  const claveOwner = process.env.TEST_PG_OWNER_PASS ?? 'owner_local';
  const claveApp = process.env.TEST_PG_APP_PASS ?? 'app_local';

  const c = new pg.Client({ connectionString: admin });
  await c.connect();
  const roles = await c.query<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE rolname IN ('vincular_owner', 'vincular_app')`);
  const existen = new Set(roles.rows.map((r) => r.rolname));
  if (!existen.has('vincular_owner')) await c.query(`CREATE ROLE vincular_owner LOGIN PASSWORD '${claveOwner}'`);
  if (!existen.has('vincular_app')) await c.query(`CREATE ROLE vincular_app LOGIN NOBYPASSRLS PASSWORD '${claveApp}'`);
  await c.query(`ALTER ROLE vincular_owner PASSWORD '${claveOwner}'`);
  await c.query(`ALTER ROLE vincular_app PASSWORD '${claveApp}'`);
  await c.query(`CREATE DATABASE ${nombre} OWNER vincular_owner ENCODING 'UTF8'`);
  await c.end();

  const enBase = new pg.Client({ connectionString: conBase(admin, nombre) });
  await enBase.connect();
  await enBase.query('REVOKE ALL ON SCHEMA public FROM PUBLIC; ALTER SCHEMA public OWNER TO vincular_owner; GRANT USAGE ON SCHEMA public TO vincular_app; CREATE EXTENSION IF NOT EXISTS vector;');
  await enBase.end();

  const urlOwner = conBase(admin, nombre, 'vincular_owner', claveOwner);
  await migrar(urlOwner);
  project.provide('urlOwner', urlOwner);
  project.provide('urlApp', conBase(admin, nombre, 'vincular_app', claveApp));

  return async () => {
    const f = new pg.Client({ connectionString: admin });
    await f.connect();
    await f.query(`DROP DATABASE IF EXISTS ${nombre} WITH (FORCE)`);
    await f.end();
  };
}
