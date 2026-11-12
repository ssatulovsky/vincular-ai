import { ErrorVoz, type ProveedorVoz } from './tipos.ts';

/** Petición HTTP con plazo; los errores no exponen claves (van en cabeceras). */
export async function pedir(
  proveedor: ProveedorVoz,
  url: string,
  init: { metodo?: 'GET' | 'POST'; cabeceras?: Record<string, string>; cuerpo?: BodyInit; timeoutMs: number; senal?: AbortSignal | undefined },
): Promise<Response> {
  const plazo = AbortSignal.timeout(init.timeoutMs);
  let r: Response;
  try {
    r = await fetch(url, {
      method: init.metodo ?? 'POST',
      ...(init.cabeceras ? { headers: init.cabeceras } : {}),
      ...(init.cuerpo !== undefined ? { body: init.cuerpo } : {}),
      signal: init.senal ? AbortSignal.any([plazo, init.senal]) : plazo,
    });
  } catch (e) {
    const n = (e as Error).name;
    throw new ErrorVoz(proveedor, n === 'TimeoutError' || n === 'AbortError' ? 'Tiempo de espera agotado' : 'No se pudo conectar con el proveedor de voz', undefined, (e as Error).message);
  }
  if (!r.ok) {
    const detalle = (await r.text().catch(() => '')).slice(0, 500);
    throw new ErrorVoz(proveedor, `El proveedor de voz respondió con error (HTTP ${r.status})`, r.status, detalle);
  }
  return r;
}

export async function pedirJson<T>(proveedor: ProveedorVoz, url: string, init: Parameters<typeof pedir>[2]): Promise<T> {
  const r = await pedir(proveedor, url, init);
  try {
    return (await r.json()) as T;
  } catch {
    throw new ErrorVoz(proveedor, 'El proveedor de voz respondió algo que no es JSON');
  }
}

export function cronometro(): () => number {
  const inicio = performance.now();
  return () => Math.round(performance.now() - inicio);
}
