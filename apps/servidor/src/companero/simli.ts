/**
 * Cliente mínimo de la API de Simli (https://docs.simli.com). Lo usan la construcción de caras
 * (caras.ts) y el avatar del agente (agente/avatarSimli.ts). La clave va solo en la cabecera
 * `x-simli-api-key`; ningún mensaje de error la incluye ni repite cabeceras.
 */

export class ErrorSimli extends Error {
  constructor(
    readonly estado: number | null,
    mensaje: string,
  ) {
    super(mensaje);
  }
  /** 403 al crear una cara: se acabaron las caras del plan. */
  get sinCupo(): boolean {
    return this.estado === 403;
  }
}

export interface AccesoSimli {
  apiKey: string;
  apiUrl: string;
}

const ESPERA_MS = 30_000;

async function llamar(url: string, init: RequestInit, esperaMs = ESPERA_MS): Promise<Response> {
  let r: Response;
  try {
    r = await fetch(url, { ...init, signal: AbortSignal.timeout(esperaMs) });
  } catch (e) {
    const causa = (e as Error).name === 'TimeoutError' ? 'tiempo de espera agotado' : 'sin conexión';
    throw new ErrorSimli(null, `Simli: ${causa}`);
  }
  if (!r.ok) {
    // El cuerpo de error de Simli explica el motivo (cara inexistente, cupo, etc.); se recorta.
    const cuerpo = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    throw new ErrorSimli(r.status, `Simli respondió ${r.status}${cuerpo ? `: ${cuerpo}` : ''}`);
  }
  return r;
}

function formulario(imagen: Buffer, mime: string): FormData {
  const f = new FormData();
  const extension = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
  f.append('image', new Blob([new Uint8Array(imagen)], { type: mime }), `retrato.${extension}`);
  return f;
}

/**
 * Pide construir una cara (Trinity-2) desde un retrato: primero Simli lo reencuadra y luego arma
 * la cara, que tarda unas 4 horas. Devuelve el ID de la cara.
 */
export async function crearCaraSimli(a: AccesoSimli, retrato: { imagen: Buffer; mime: string }, nombre: string): Promise<string> {
  const pre = await llamar(`${a.apiUrl}/faces/trinity/preprocess`, { method: 'POST', headers: { 'x-simli-api-key': a.apiKey }, body: formulario(retrato.imagen, retrato.mime) }, 60_000);
  const proporcion = pre.headers.get('target-ratio');
  const encuadrada = Buffer.from(await pre.arrayBuffer());
  const r = await llamar(
    `${a.apiUrl}/faces/trinity?face_name=${encodeURIComponent(nombre)}`,
    { method: 'POST', headers: { 'x-simli-api-key': a.apiKey, ...(proporcion ? { 'target-ratio': proporcion } : {}) }, body: formulario(encuadrada, 'image/png') },
    60_000,
  );
  const cuerpo = (await r.json().catch(() => null)) as { face_id?: unknown } | null;
  if (typeof cuerpo?.face_id !== 'string' || !cuerpo.face_id) throw new ErrorSimli(r.status, 'Simli no devolvió el ID de la cara');
  return cuerpo.face_id;
}

/** Estado de construcción de una cara. */
export async function estadoCaraSimli(a: AccesoSimli, caraId: string): Promise<'construyendo' | 'lista' | 'fallida'> {
  const r = await llamar(`${a.apiUrl}/faces/trinity/generation_status?face_id=${encodeURIComponent(caraId)}`, { headers: { 'x-simli-api-key': a.apiKey } }, 5_000);
  const cuerpo = (await r.json().catch(() => null)) as { status?: unknown } | null;
  const estado = typeof cuerpo?.status === 'string' ? cuerpo.status.toLowerCase() : '';
  if (estado === 'completed') return 'lista';
  if (estado === 'failed') return 'fallida';
  return 'construyendo';
}

export interface OpcionesSesionSimli {
  caraId: string;
  /** Segundos: Simli corta el avatar al llegar aquí aunque esté hablando. */
  maxSesionS: number;
  /** Segundos sin audio tras los cuales el avatar se va (y deja de cobrar). */
  maxInactividadS: number;
  zoom: number | null;
}

/** Permiso de una sesión de avatar (Simli recomienda acotar siempre duración e inactividad). */
export async function tokenSesionSimli(a: AccesoSimli, o: OpcionesSesionSimli): Promise<string> {
  const cuerpo = {
    faceId: o.caraId,
    handleSilence: true,
    maxSessionLength: o.maxSesionS,
    maxIdleTime: o.maxInactividadS,
    // Cuadrado: la tablet muestra la cara en un círculo.
    streaming_width: 768,
    streaming_height: 768,
    ...(o.zoom ? { camera: { zoom: o.zoom } } : {}),
  };
  const r = await llamar(`${a.apiUrl}/compose/token`, { method: 'POST', headers: { 'x-simli-api-key': a.apiKey, 'content-type': 'application/json' }, body: JSON.stringify(cuerpo) }, 10_000);
  const datos = (await r.json().catch(() => null)) as { session_token?: unknown } | null;
  if (typeof datos?.session_token !== 'string' || !datos.session_token) throw new ErrorSimli(r.status, 'Simli no devolvió el permiso de la sesión');
  return datos.session_token;
}

/** Simli entra a la sala de LiveKit con su propio permiso y publica la cara y la voz. */
export async function unirSimliASala(a: AccesoSimli, sesion: { sessionToken: string; livekitToken: string; livekitUrl: string }): Promise<void> {
  await llamar(
    `${a.apiUrl}/integrations/livekit/agents`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_token: sesion.sessionToken, livekit_token: sesion.livekitToken, livekit_url: sesion.livekitUrl }) },
    10_000,
  );
}
