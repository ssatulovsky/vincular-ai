/**
 * Normalización de texto para las reglas.
 *
 * El texto llega de la tablet (y desde el Sprint 3, del reconocimiento de voz), a veces sin
 * tildes, con mayúsculas al azar o con abreviaturas de chat. Las reglas se escriben contra
 * el texto normalizado: minúsculas, sin tildes, sin puntuación y con espacios simples.
 */

const ABREVIATURAS: ReadonlyArray<[RegExp, string]> = [
  [/\bq\b/g, 'que'],
  [/\bxq\b/g, 'porque'],
  [/\bpq\b/g, 'porque'],
  [/\bpa\b/g, 'para'],
  [/\bna\b/g, 'nada'],
  [/\btoy\b/g, 'estoy'],
  [/\btai\b/g, 'estas'],
  [/\bkiero\b/g, 'quiero'],
  [/\bkero\b/g, 'quiero'],
  [/\bweno\b/g, 'bueno'],
];

export function normalizar(texto: string): string {
  let t = texto
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  for (const [patron, reemplazo] of ABREVIATURAS) t = t.replace(patron, reemplazo);
  return t.replace(/\s+/g, ' ');
}
