import { ErrorProveedor, type Proveedor } from './tipos.ts';

export async function pedirJson(
  proveedor: Proveedor,
  url: string,
  init: { metodo?: 'GET' | 'POST'; cabeceras: Record<string, string>; cuerpo?: unknown; timeoutMs: number; senal?: AbortSignal | undefined },
): Promise<unknown> {
  const plazo = AbortSignal.timeout(init.timeoutMs);
  let r: Response;
  try {
    r = await fetch(url, {
      method: init.metodo ?? 'POST',
      headers: { 'content-type': 'application/json', ...init.cabeceras },
      ...(init.cuerpo === undefined ? {} : { body: JSON.stringify(init.cuerpo) }),
      signal: init.senal ? AbortSignal.any([plazo, init.senal]) : plazo,
    });
  } catch (e) {
    const nombre = (e as Error).name;
    const agotado = nombre === 'TimeoutError' || nombre === 'AbortError';
    throw new ErrorProveedor(proveedor, agotado ? 'Tiempo de espera agotado' : 'No se pudo conectar con el proveedor', undefined, (e as Error).message);
  }
  const texto = await r.text();
  if (!r.ok) {
    // La clave va en cabeceras, nunca en la URL ni en el cuerpo: el detalle no la contiene.
    throw new ErrorProveedor(proveedor, `El proveedor respondió con error (HTTP ${r.status})`, r.status, texto.slice(0, 500));
  }
  try {
    return JSON.parse(texto) as unknown;
  } catch {
    throw new ErrorProveedor(proveedor, 'El proveedor respondió algo que no es JSON');
  }
}

/** Quita del JSON Schema claves que Gemini no acepta. */
export function esquemaParaGemini(esquema: unknown): unknown {
  if (Array.isArray(esquema)) return esquema.map(esquemaParaGemini);
  if (esquema && typeof esquema === 'object') {
    return Object.fromEntries(
      Object.entries(esquema as Record<string, unknown>)
        .filter(([k]) => !['$schema', 'additionalProperties', '$id', '$defs'].includes(k))
        .map(([k, v]) => [k, esquemaParaGemini(v)]),
    );
  }
  return esquema;
}
