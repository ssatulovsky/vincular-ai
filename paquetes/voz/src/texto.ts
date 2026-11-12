/**
 * Preparación del texto para hablarlo y métricas de reconocimiento. Funciones puras.
 */

const DIGITOS = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'];

/**
 * Números de teléfono y de emergencia se dicen dígito por dígito ("131" → "uno tres uno",
 * "*4141" → "asterisco cuatro uno cuatro uno"): una persona mayor debe poder marcarlos al oírlos.
 */
export function numeroParaVoz(numero: string): string {
  return [...numero]
    .map((c) => (c === '*' ? 'asterisco' : c === '#' ? 'gato' : c === '+' ? 'más' : /\d/.test(c) ? DIGITOS[Number(c)] : ''))
    .filter(Boolean)
    .join(' ');
}

/**
 * Texto listo para el sintetizador: sin marcas de formato ni emojis, y con los números indicados
 * (los de emergencia y teléfonos) dichos dígito por dígito.
 */
export function prepararParaVoz(texto: string, numerosDigitoADigito: readonly string[] = []): string {
  let t = texto
    .replace(/\*\*|__|`/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\p{Extended_Pictographic}️?/gu, '');
  // Los más largos primero, para no partir "*4141" al reemplazar "41".
  for (const n of [...numerosDigitoADigito].sort((a, b) => b.length - a.length)) {
    if (!n) continue;
    const escapado = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`(?<![\\d*])${escapado}(?!\\d)`, 'g'), numeroParaVoz(n));
  }
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * Divide una respuesta en frases para sintetizarlas por separado: la primera frase empieza a
 * sonar mientras se sintetizan las demás. Une frases muy cortas para no fragmentar la prosodia.
 */
export function dividirEnFrases(texto: string, minimo = 25): string[] {
  const crudas = texto.match(/[^.!?¿¡…]*(?:[¿¡][^?!]*[?!]|[^.!?…]+[.!?…]+|[^.!?…]+$)/g) ?? [texto];
  const frases: string[] = [];
  for (const f of crudas.map((x) => x.trim()).filter(Boolean)) {
    const ultima = frases[frases.length - 1];
    if (ultima !== undefined && ultima.length < minimo) frases[frases.length - 1] = `${ultima} ${f}`;
    else frases.push(f);
  }
  return frases.length ? frases : [texto.trim()].filter(Boolean);
}

function palabras(t: string): string[] {
  return t
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Tasa de error por palabra (WER) entre la transcripción de referencia y la reconocida, sin
 * tildes, mayúsculas ni puntuación. 0 = perfecta. Puede superar 1 si se inventan palabras.
 */
export function tasaErrorPalabras(referencia: string, reconocido: string): number {
  const r = palabras(referencia);
  const h = palabras(reconocido);
  if (r.length === 0) return h.length === 0 ? 0 : 1;
  let previa = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const actual = [i];
    for (let j = 1; j <= h.length; j++) {
      actual[j] = Math.min(previa[j]! + 1, actual[j - 1]! + 1, previa[j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1));
    }
    previa = actual;
  }
  return previa[h.length]! / r.length;
}
