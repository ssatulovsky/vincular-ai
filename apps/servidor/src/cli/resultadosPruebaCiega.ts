/**
 * Junta los CSV descargados de la prueba ciega y descubre qué voz era cada letra.
 *
 *   npm run voz:resultados -- --clave salida/prueba-ciega-.../clave.json resultados/*.csv
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { leerCsvResultados, resumirResultados } from '../voz/pruebaCiega.ts';

const { values, positionals } = parseArgs({ options: { clave: { type: 'string' } }, allowPositionals: true });
if (!values.clave || positionals.length === 0) {
  console.error('Uso: npm run voz:resultados -- --clave clave.json archivo1.csv [archivo2.csv …]');
  process.exit(1);
}
const { clave } = JSON.parse(readFileSync(values.clave, 'utf8')) as { clave: Record<string, string> };
const filas = positionals.flatMap((a) => leerCsvResultados(readFileSync(a, 'utf8')));
const participantes = new Set(filas.map((f) => f.participante)).size;
console.log(`Participantes: ${participantes}\n`);
console.log('| Voz | Letra | Elegida por | Naturalidad | Claridad | Calidez | Calificaciones |');
console.log('|---|---|---|---|---|---|---|');
for (const r of resumirResultados(filas, clave)) {
  console.log(`| ${r.vozId} | ${r.letra} | ${r.preferidaPor} | ${r.naturalidad ?? '-'} | ${r.claridad ?? '-'} | ${r.calidez ?? '-'} | ${r.calificaciones} |`);
}
