/** Celdas de una línea CSV con comillas dobles (RFC 4180, sin saltos de línea dentro de celdas). */
export function celdasCsv(linea: string): string[] {
  const r: string[] = [];
  let actual = '';
  let comillas = false;
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i]!;
    if (comillas) {
      if (c === '"' && linea[i + 1] === '"') {
        actual += '"';
        i++;
      } else if (c === '"') comillas = false;
      else actual += c;
    } else if (c === '"') comillas = true;
    else if (c === ',') {
      r.push(actual);
      actual = '';
    } else actual += c;
  }
  r.push(actual);
  return r;
}

export function leerCsv(texto: string): Array<Record<string, string>> {
  const lineas = texto.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  const cabecera = celdasCsv(lineas[0] ?? '').map((c) => c.trim());
  return lineas.slice(1).map((l) => {
    const c = celdasCsv(l);
    return Object.fromEntries(cabecera.map((h, i) => [h, (c[i] ?? '').trim()]));
  });
}
