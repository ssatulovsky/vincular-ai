/**
 * Crea la primera cuenta de administrador de plataforma (las demás se crean por la API).
 *
 *   npm run cli:crear-cuenta -w @vincular/servidor -- --email admin@vincular.cl --nombre "Admin" --rol admin_plataforma
 *
 * La contraseña se lee de la variable CONTRASENA_NUEVA para no dejarla en el historial.
 */
import { parseArgs } from 'node:util';
import { cargarConfig } from '../config/config.ts';
import { crearPool } from '../db/conexion.ts';
import { auditar } from '../seguridad/auditoria.ts';
import { hashContrasena } from '../seguridad/autenticacion.ts';

const { values } = parseArgs({ options: { email: { type: 'string' }, nombre: { type: 'string' }, rol: { type: 'string', default: 'admin_plataforma' } } });
const contrasena = process.env.CONTRASENA_NUEVA;
if (!values.email || !values.nombre || !contrasena) {
  console.error('Uso: CONTRASENA_NUEVA=... npm run cli:crear-cuenta -- --email <correo> --nombre <nombre> [--rol <rol>]');
  process.exit(1);
}
const config = cargarConfig();
const bd = crearPool(config.databaseUrl);
try {
  const r = await bd.query<{ id: string }>(`INSERT INTO cuenta (tipo, email, nombre, hash_contrasena, rol) VALUES ('personal', $1, $2, $3, $4) RETURNING id`, [
    values.email.toLowerCase(),
    values.nombre,
    await hashContrasena(contrasena),
    values.rol,
  ]);
  await auditar(bd, { tipo: 'sistema' }, { accion: 'cuenta.crear_cli', recursoTipo: 'cuenta', recursoId: r.rows[0]!.id, detalle: { rol: values.rol } });
  console.log(`Cuenta creada: ${r.rows[0]!.id}`);
} finally {
  await bd.end();
}
