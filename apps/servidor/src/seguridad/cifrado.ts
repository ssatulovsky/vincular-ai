import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Cifrado en reposo con AES-256-GCM.
 * Formato: [versión 1 byte][iv 12 bytes][etiqueta 16 bytes][texto cifrado].
 * La versión permite rotar claves sin migrar todo de una vez (TODO Sprint 9: gestión de claves
 * con un servicio de la nube en vez de una variable de entorno).
 */
const VERSION = 1;

export class Cifrador {
  constructor(private readonly clave: Buffer) {
    if (clave.length !== 32) throw new Error('La clave de cifrado debe tener 32 bytes');
  }

  cifrar(texto: string): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.clave, iv);
    const datos = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, c.getAuthTag(), datos]);
  }

  descifrar(b: Buffer): string {
    if (b.length < 29 || b[0] !== VERSION) throw new Error('Dato cifrado con formato desconocido');
    const d = createDecipheriv('aes-256-gcm', this.clave, b.subarray(1, 13));
    d.setAuthTag(b.subarray(13, 29));
    return Buffer.concat([d.update(b.subarray(29)), d.final()]).toString('utf8');
  }

  cifrarJson(v: unknown): Buffer {
    return this.cifrar(JSON.stringify(v));
  }

  descifrarJson<T = unknown>(b: Buffer): T {
    return JSON.parse(this.descifrar(b)) as T;
  }
}
