import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Twilio: SMS y llamadas (API REST 2010-04-01), sin SDK. Las credenciales van en la cabecera
 * de autenticación; los errores nunca las incluyen.
 */
export interface CanalMensajeria {
  enviarSms(p: { a: string; texto: string; urlEstado?: string | undefined }): Promise<{ id: string }>;
  llamar(p: { a: string; twiml: string; urlEstado?: string | undefined }): Promise<{ id: string }>;
}

export interface ConfigTwilio {
  accountSid: string;
  authToken: string;
  /** Número de origen en E.164, o MessagingServiceSid (MG…) para SMS. */
  origen: string;
  /** Solo para pruebas: URL base de la API. */
  url?: string;
  timeoutMs?: number;
}

export class ErrorCanal extends Error {
  constructor(
    mensaje: string,
    readonly estado?: number,
    readonly interno?: string,
  ) {
    super(mensaje);
    this.name = 'ErrorCanal';
  }
}

export class CanalTwilio implements CanalMensajeria {
  constructor(private readonly c: ConfigTwilio) {}

  private async post(recurso: 'Messages' | 'Calls', campos: Record<string, string>): Promise<{ id: string }> {
    const url = `${this.c.url ?? 'https://api.twilio.com'}/2010-04-01/Accounts/${encodeURIComponent(this.c.accountSid)}/${recurso}.json`;
    let r: Response;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${this.c.accountSid}:${this.c.authToken}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(campos),
        signal: AbortSignal.timeout(this.c.timeoutMs ?? 15_000),
      });
    } catch (e) {
      throw new ErrorCanal('No se pudo conectar con Twilio', undefined, (e as Error).message);
    }
    const texto = await r.text();
    if (!r.ok) throw new ErrorCanal(`Twilio respondió con error (HTTP ${r.status})`, r.status, texto.slice(0, 300));
    const d = JSON.parse(texto) as { sid?: string };
    if (!d.sid) throw new ErrorCanal('Twilio no devolvió un identificador');
    return { id: d.sid };
  }

  private origen(): Record<string, string> {
    return this.c.origen.startsWith('MG') ? { MessagingServiceSid: this.c.origen } : { From: this.c.origen };
  }

  enviarSms(p: { a: string; texto: string; urlEstado?: string | undefined }) {
    return this.post('Messages', { To: p.a, Body: p.texto, ...this.origen(), ...(p.urlEstado ? { StatusCallback: p.urlEstado } : {}) });
  }

  llamar(p: { a: string; twiml: string; urlEstado?: string | undefined }) {
    if (this.c.origen.startsWith('MG')) throw new ErrorCanal('Para llamar se necesita un número de origen (no un servicio de mensajería)');
    return this.post('Calls', {
      To: p.a,
      From: this.c.origen,
      Twiml: p.twiml,
      Timeout: '30',
      ...(p.urlEstado ? { StatusCallback: p.urlEstado, StatusCallbackEvent: 'completed' } : {}),
    });
  }
}

/**
 * Firma de Twilio (cabecera X-Twilio-Signature): HMAC-SHA1 con el auth token sobre la URL
 * completa seguida de cada parámetro POST (nombre y valor) ordenados por nombre, en base64.
 */
export function firmaTwilio(authToken: string, url: string, parametros: Record<string, string>): string {
  const datos = Object.keys(parametros)
    .sort()
    .reduce((acc, k) => acc + k + parametros[k], url);
  return createHmac('sha1', authToken).update(Buffer.from(datos, 'utf8')).digest('base64');
}

export function firmaValida(authToken: string, url: string, parametros: Record<string, string>, recibida: string | undefined): boolean {
  if (!recibida) return false;
  const esperada = Buffer.from(firmaTwilio(authToken, url, parametros));
  const dada = Buffer.from(recibida);
  return esperada.length === dada.length && timingSafeEqual(esperada, dada);
}

const xml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

/**
 * Llamada: dice el mensaje dos veces y, si hay URL pública, pide presionar 1 para hacerse cargo.
 */
export function twimlLlamada(p: { texto: string; idioma: string; voz?: string | undefined; urlRespuesta?: string | undefined }): string {
  const say = `<Say language="${xml(p.idioma)}"${p.voz ? ` voice="${xml(p.voz)}"` : ''}>${xml(p.texto)}</Say>`;
  const pausa = '<Pause length="1"/>';
  if (!p.urlRespuesta) return `<?xml version="1.0" encoding="UTF-8"?><Response>${say}${pausa}${say}</Response>`;
  const pedir = `<Say language="${xml(p.idioma)}"${p.voz ? ` voice="${xml(p.voz)}"` : ''}>Si usted se hace cargo, presione 1.</Say>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Gather numDigits="1" timeout="8" action="${xml(p.urlRespuesta)}" method="POST">${say}${pausa}${pedir}</Gather>${say}${pedir.replace('Si usted se hace cargo, presione 1.', 'Revise sus mensajes, por favor.')}</Response>`;
}

export function twimlRespuesta(texto?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${texto ? `<Message>${xml(texto)}</Message>` : ''}</Response>`;
}

export function twimlDecir(texto: string, idioma: string, voz?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="${xml(idioma)}"${voz ? ` voice="${xml(voz)}"` : ''}>${xml(texto)}</Say></Response>`;
}
