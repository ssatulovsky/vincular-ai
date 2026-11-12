import { createHmac, hkdfSync } from 'node:crypto';

/**
 * Teléfonos en formato E.164. Acepta "+56 9 1111 2222", "9 1111 2222" o "56911112222".
 * Los celulares chilenos sin prefijo (9 dígitos que empiezan con 9) se completan con +56.
 */
export function normalizarTelefono(t: string): string | null {
  const limpio = t.replace(/[\s().-]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(limpio)) return limpio;
  if (/^9\d{8}$/.test(limpio)) return `+56${limpio}`;
  if (/^569\d{8}$/.test(limpio)) return `+${limpio}`;
  return null;
}

/**
 * Hash del teléfono para encontrar a quién respondió un SMS sin descifrar todos los teléfonos.
 * HMAC con una clave derivada de la clave de cifrado (no un hash simple: los teléfonos son pocos
 * y se podrían adivinar por fuerza bruta).
 */
export class HashTelefonos {
  private readonly clave: Buffer;
  constructor(claveCifrado: Buffer) {
    this.clave = Buffer.from(hkdfSync('sha256', claveCifrado, Buffer.alloc(0), 'vincular-ia/telefono', 32));
  }
  hash(telefono: string): Buffer {
    const n = normalizarTelefono(telefono);
    if (!n) throw new Error('Teléfono inválido');
    return createHmac('sha256', this.clave).update(n).digest();
  }
}

/** "+56911112222" → "+56 9 •••• 2222", para mostrar en el panel sin exponer el número. */
export function enmascarar(telefono: string): string {
  const n = normalizarTelefono(telefono) ?? telefono;
  return `${n.slice(0, 3)} ${n.slice(3, 4)} •••• ${n.slice(-4)}`;
}
