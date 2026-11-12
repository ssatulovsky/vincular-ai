import { hash, verify } from '@node-rs/argon2';
import type { Bd } from '../db/conexion.ts';
import { auditar } from './auditoria.ts';
import type { Actor, RolPersonal } from './permisos.ts';
import { hashToken, nuevoToken } from './tokens.ts';

const MAX_INTENTOS = 5;
const MINUTOS_BLOQUEO = 15;
// Hash de una contraseña que nadie tiene: se verifica aunque la cuenta no exista, para que el
// tiempo de respuesta no revele qué correos están registrados.
let hashSenuelo: Promise<string> | undefined;

export async function hashContrasena(contrasena: string): Promise<string> {
  if (contrasena.length < 12) throw new Error('La contraseña debe tener al menos 12 caracteres');
  return hash(contrasena);
}

export type ResultadoIngreso = { ok: true; token: string; expiraEn: Date } | { ok: false };

/**
 * Ingreso con correo y contraseña (personal clínico y familiares). Mismo resultado para cuenta
 * inexistente, bloqueada o contraseña incorrecta. Bloqueo tras 5 intentos fallidos.
 * TODO(Sprint 6): segundo factor obligatorio para el personal clínico.
 */
export async function ingresar(bd: Bd, email: string, contrasena: string, horas: number, ip?: string): Promise<ResultadoIngreso> {
  const correo = email.trim().toLowerCase();
  const c = await bd.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query<{ id: string; hash_contrasena: string; activa: boolean; bloqueada_hasta: Date | null; intentos_fallidos: number }>(
      'SELECT id, hash_contrasena, activa, bloqueada_hasta, intentos_fallidos FROM cuenta WHERE email = $1 FOR UPDATE',
      [correo],
    );
    const cuenta = r.rows[0];
    if (!cuenta) {
      hashSenuelo ??= hash('cuenta-inexistente-senuelo');
      await verify(await hashSenuelo, contrasena).catch(() => false);
      await c.query('COMMIT');
      return { ok: false };
    }
    const bloqueada = !cuenta.activa || (cuenta.bloqueada_hasta !== null && cuenta.bloqueada_hasta > new Date());
    const valida = await verify(cuenta.hash_contrasena, contrasena).catch(() => false);
    if (bloqueada || !valida) {
      if (!bloqueada) {
        const intentos = cuenta.intentos_fallidos + 1;
        if (intentos >= MAX_INTENTOS) {
          await c.query(`UPDATE cuenta SET intentos_fallidos = 0, bloqueada_hasta = now() + make_interval(mins => $2) WHERE id = $1`, [cuenta.id, MINUTOS_BLOQUEO]);
          await auditar(c, { tipo: 'sistema' }, { accion: 'cuenta.bloqueada', recursoTipo: 'cuenta', recursoId: cuenta.id, detalle: { ip: ip ?? null } });
        } else {
          await c.query('UPDATE cuenta SET intentos_fallidos = $2 WHERE id = $1', [cuenta.id, intentos]);
        }
      }
      await c.query('COMMIT');
      return { ok: false };
    }
    const { token, hash: tokenHash } = nuevoToken();
    const s = await c.query<{ expira_en: Date }>(
      `INSERT INTO sesion_acceso (cuenta_id, token_hash, expira_en, ip) VALUES ($1, $2, now() + make_interval(hours => $3), $4) RETURNING expira_en`,
      [cuenta.id, tokenHash, horas, ip ?? null],
    );
    await c.query('UPDATE cuenta SET intentos_fallidos = 0, bloqueada_hasta = NULL WHERE id = $1', [cuenta.id]);
    await c.query('COMMIT');
    return { ok: true, token, expiraEn: s.rows[0]!.expira_en };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

export async function cerrarSesion(bd: Bd, token: string): Promise<void> {
  await bd.query('UPDATE sesion_acceso SET cerrada_en = now() WHERE token_hash = $1 AND cerrada_en IS NULL', [hashToken(token)]);
}

/** Resuelve el actor de un token de sesión (personal o familiar) o de dispositivo. */
export async function actorDesdeToken(bd: Bd, token: string): Promise<Actor | null> {
  const h = hashToken(token);
  const s = await bd.query<{ id: string; tipo: 'personal' | 'familiar'; rol: RolPersonal | null; nombre: string; contacto_id: string | null; persona_id: string | null }>(
    `SELECT cu.id, cu.tipo, cu.rol, cu.nombre, cu.contacto_id, co.persona_id
       FROM sesion_acceso s
       JOIN cuenta cu ON cu.id = s.cuenta_id
       LEFT JOIN contacto co ON co.id = cu.contacto_id
      WHERE s.token_hash = $1 AND s.cerrada_en IS NULL AND s.expira_en > now() AND cu.activa`,
    [h],
  );
  const fila = s.rows[0];
  if (fila) {
    if (fila.tipo === 'personal') return { tipo: 'personal', id: fila.id, rol: fila.rol!, nombre: fila.nombre };
    return { tipo: 'familiar', id: fila.id, contactoId: fila.contacto_id!, personaId: fila.persona_id!, nombre: fila.nombre };
  }
  const d = await bd.query<{ id: string; persona_id: string }>(
    `UPDATE dispositivo SET ultimo_uso_en = now() WHERE token_hash = $1 AND revocado_en IS NULL RETURNING id, persona_id`,
    [h],
  );
  const disp = d.rows[0];
  return disp ? { tipo: 'dispositivo', id: disp.id, personaId: disp.persona_id } : null;
}
