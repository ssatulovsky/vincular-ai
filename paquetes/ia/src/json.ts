/**
 * Extrae el primer objeto JSON de una respuesta de modelo. Tolera bloques ```json``` y texto
 * alrededor; no intenta "reparar" JSON inválido: si no se puede leer, devuelve null y el
 * llamador aplica su política conservadora.
 */
export function extraerObjetoJson(texto: string): unknown {
  const sinCercas = texto.replace(/```(?:json)?/gi, '').trim();
  const inicio = sinCercas.indexOf('{');
  const fin = sinCercas.lastIndexOf('}');
  if (inicio < 0 || fin <= inicio) return null;
  try {
    return JSON.parse(sinCercas.slice(inicio, fin + 1)) as unknown;
  } catch {
    return null;
  }
}
