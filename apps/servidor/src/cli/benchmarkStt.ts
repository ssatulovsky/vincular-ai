/**
 * Benchmark de reconocimiento de voz con grabaciones reales (ver docs/voz/protocolo-grabaciones.md).
 *
 *   npm run voz:benchmark-stt -- --guion > manifiesto.csv     plantilla con las frases a grabar
 *   npm run voz:benchmark-stt -- carpeta [--proveedores google,elevenlabs]
 *
 * La carpeta tiene los audios y un `manifiesto.csv` con columnas: archivo,referencia,condicion
 * (referencia = lo que la persona dijo de verdad, transcrito a mano).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ServiciosVoz, type ProveedorVoz } from '@vincular/voz';
import { cargarConfigVoz } from '../config/config.ts';
import { leerCsv } from '../utilidades/csv.ts';
import { evaluarTranscripcion, resumirBenchmark, type FilaBenchmark } from '../voz/benchmark.ts';

const { values, positionals } = parseArgs({ options: { proveedores: { type: 'string', default: 'google,elevenlabs' }, guion: { type: 'boolean', default: false } }, allowPositionals: true });
const { voz: cv } = cargarConfigVoz();
const raiz = path.resolve(path.dirname(cv.catalogo), '..', '..');

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

if (values.guion) {
  // Frases cotidianas + los casos de riesgo (ver el protocolo: las de riesgo se graban con
  // voluntarios y aprobación del equipo clínico, nunca con participantes del piloto).
  const cotidianas = (JSON.parse(readFileSync(path.join(raiz, 'config/voz/frases-grabacion.json'), 'utf8')) as { frases: string[] }).frases;
  const riesgo = (JSON.parse(readFileSync(path.join(raiz, 'paquetes/seguridad-clinica/casos/riesgo.casos.json'), 'utf8')) as { casos: Array<{ texto: string; tipo: string }> }).casos.filter((c) => c.tipo !== 'benigno');
  const filas = ['archivo,referencia,condicion,grupo'];
  cotidianas.forEach((t, i) => filas.push(`c${String(i + 1).padStart(2, '0')}.wav,${q(t)},,cotidiana`));
  riesgo.forEach((c, i) => filas.push(`r${String(i + 1).padStart(2, '0')}.wav,${q(c.texto)},,riesgo`));
  console.log(filas.join('\n'));
  process.exit(0);
}

const carpeta = positionals[0];
if (!carpeta) {
  console.error('Uso: npm run voz:benchmark-stt -- <carpeta con manifiesto.csv> [--proveedores google,elevenlabs]');
  process.exit(1);
}
const MIME: Record<string, string> = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.flac': 'audio/flac' };
const manifiesto = leerCsv(readFileSync(path.join(carpeta, 'manifiesto.csv'), 'utf8')).map((f) => ({ archivo: f.archivo ?? '', referencia: f.referencia ?? '', condicion: f.condicion ?? '' }));
if (manifiesto.some((m) => !m.archivo || !m.referencia)) {
  console.error('El manifiesto necesita las columnas archivo y referencia en todas las filas.');
  process.exit(1);
}

const servicios = new ServiciosVoz(cv.servicios);
const filas: FilaBenchmark[] = [];
for (const proveedor of values.proveedores!.split(',').map((x) => x.trim()) as ProveedorVoz[]) {
  const { reconocedor, idioma } = servicios.reconocedorDe(proveedor, proveedor === 'google' ? (cv.servicios.reconocimiento.proveedor === 'google' ? cv.servicios.reconocimiento.idioma : 'es-US') : 'es');
  for (const m of manifiesto) {
    const audio = readFileSync(path.join(carpeta, m.archivo));
    const mime = MIME[path.extname(m.archivo).toLowerCase()] ?? 'application/octet-stream';
    try {
      const r = await reconocedor.reconocer({ audio, mime, idioma });
      filas.push({ proveedor, archivo: m.archivo, condicion: m.condicion, latenciaMs: r.latenciaMs, error: null, reconocido: r.texto, ...evaluarTranscripcion(m.referencia, r.texto) });
    } catch (e) {
      filas.push({ proveedor, archivo: m.archivo, condicion: m.condicion, latenciaMs: null, error: (e as Error).message, reconocido: '', ...evaluarTranscripcion(m.referencia, '') });
    }
    process.stdout.write('.');
  }
}

const detalle = ['proveedor,archivo,condicion,wer,latencia_ms,nivel_referencia,nivel_reconocido,riesgo_perdido,error,reconocido'];
for (const f of filas) detalle.push([f.proveedor, f.archivo, q(f.condicion), f.wer.toFixed(3), f.latenciaMs ?? '', f.nivelReferencia, f.nivelReconocido, f.riesgoPerdido ? 'SI' : '', q(f.error ?? ''), q(f.reconocido)].join(','));
writeFileSync(path.join(carpeta, 'resultado-stt.csv'), '﻿' + detalle.join('\n'));

const resumen = ['', '| Proveedor | Audios | Fallas | WER | Latencia p50 (ms) | p90 (ms) | Frases de riesgo | Riesgos perdidos |', '|---|---|---|---|---|---|---|---|'];
for (const r of resumirBenchmark(filas)) resumen.push(`| ${r.proveedor} | ${r.audios} | ${r.fallas} | ${r.werPromedio ?? '-'} | ${r.latenciaP50 ?? '-'} | ${r.latenciaP90 ?? '-'} | ${r.frasesDeRiesgo} | ${r.riesgosPerdidos} |`);
resumen.push('', 'Un riesgo perdido es una frase de riesgo que el detector deja de ver después del reconocimiento. Debe ser 0 en las frases críticas.');
writeFileSync(path.join(carpeta, 'resultado-stt.md'), resumen.join('\n') + '\n');
console.log(`\n${resumen.join('\n')}\n\nDetalle: ${path.join(carpeta, 'resultado-stt.csv')}`);
