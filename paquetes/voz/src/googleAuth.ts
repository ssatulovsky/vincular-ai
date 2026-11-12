import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ErrorVoz } from './tipos.ts';

/**
 * Credenciales de Google Cloud. Dos formas:
 *   - Cuenta de servicio (archivo JSON): necesaria para Speech-to-Text v2 (Chirp 3) y Gemini-TTS.
 *   - Clave de API: sirve para Cloud Text-to-Speech con voces Chirp 3 HD.
 * Se firma el JWT con node:crypto para no agregar dependencias.
 */
export interface CuentaServicio {
  client_email: string;
  private_key: string;
  project_id: string;
  token_uri?: string;
}

export type CredencialGoogle = { tipo: 'cuenta_servicio'; cuenta: CuentaServicio } | { tipo: 'clave_api'; clave: string; proyecto?: string };

export function leerCuentaServicio(ruta: string): CuentaServicio {
  const c = JSON.parse(readFileSync(ruta, 'utf8')) as Partial<CuentaServicio>;
  if (!c.client_email || !c.private_key || !c.project_id) throw new Error(`El archivo ${ruta} no parece una cuenta de servicio de Google`);
  return c as CuentaServicio;
}

const base64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** JWT firmado para el intercambio por un token de acceso (RFC 7523). Función pura salvo la hora. */
export function firmarJwt(cuenta: CuentaServicio, ahora = Math.floor(Date.now() / 1000), alcance = 'https://www.googleapis.com/auth/cloud-platform'): string {
  const cabecera = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const cuerpo = base64url(JSON.stringify({ iss: cuenta.client_email, scope: alcance, aud: cuenta.token_uri ?? 'https://oauth2.googleapis.com/token', iat: ahora, exp: ahora + 3600 }));
  const firma = createSign('RSA-SHA256').update(`${cabecera}.${cuerpo}`).sign(cuenta.private_key);
  return `${cabecera}.${cuerpo}.${base64url(firma)}`;
}

export class AutenticadorGoogle {
  private token: { valor: string; vence: number } | null = null;
  private pendiente: Promise<string> | null = null;

  constructor(readonly credencial: CredencialGoogle) {}

  get proyecto(): string | undefined {
    return this.credencial.tipo === 'cuenta_servicio' ? this.credencial.cuenta.project_id : this.credencial.proyecto;
  }

  /** Cabeceras de autenticación para una petición a Google Cloud. */
  async cabeceras(): Promise<Record<string, string>> {
    if (this.credencial.tipo === 'clave_api') {
      return { 'x-goog-api-key': this.credencial.clave, ...(this.credencial.proyecto ? { 'x-goog-user-project': this.credencial.proyecto } : {}) };
    }
    return { authorization: `Bearer ${await this.tokenDeAcceso()}`, 'x-goog-user-project': this.credencial.cuenta.project_id };
  }

  private async tokenDeAcceso(): Promise<string> {
    if (this.token && this.token.vence > Date.now() + 60_000) return this.token.valor;
    this.pendiente ??= this.pedirToken().finally(() => {
      this.pendiente = null;
    });
    return this.pendiente;
  }

  private async pedirToken(): Promise<string> {
    if (this.credencial.tipo !== 'cuenta_servicio') throw new Error('Sin cuenta de servicio');
    const cuenta = this.credencial.cuenta;
    let r: Response;
    try {
      r = await fetch(cuenta.token_uri ?? 'https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: firmarJwt(cuenta) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new ErrorVoz('google', 'No se pudo obtener el token de Google', undefined, (e as Error).message);
    }
    if (!r.ok) throw new ErrorVoz('google', `Google rechazó la cuenta de servicio (HTTP ${r.status})`, r.status, (await r.text()).slice(0, 300));
    const d = (await r.json()) as { access_token: string; expires_in: number };
    this.token = { valor: d.access_token, vence: Date.now() + d.expires_in * 1000 };
    return d.access_token;
  }
}
