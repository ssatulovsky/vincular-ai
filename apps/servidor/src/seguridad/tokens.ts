import { createHash, randomBytes } from 'node:crypto';

/** Token opaco para sesiones y dispositivos. En la base solo se guarda su hash. */
export function nuevoToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}
