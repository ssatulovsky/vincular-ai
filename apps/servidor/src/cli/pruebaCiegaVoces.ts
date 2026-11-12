/**
 * Genera la prueba ciega de voces: sintetiza las frases de prueba con cada voz candidata y arma
 * una página HTML autocontenida para escuchar y calificar en las sesiones de co-diseño.
 *
 *   npm run voz:prueba-ciega -- [--voces id1,id2] [--velocidad 0.95] [--salida carpeta]
 *
 * Salida (carpeta nueva por ejecución):
 *   prueba.html   abrir en la tablet; no necesita internet
 *   clave.json    qué voz es cada letra: NO abrir durante las sesiones
 *   informe.md    latencia y caracteres por voz, y voces que fallaron
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { respuestaSeguraPara } from '@vincular/seguridad-clinica';
import { ServiciosVoz, prepararParaVoz, validarCatalogo, type VozConfigurada } from '@vincular/voz';
import { cargarConfigVoz } from '../config/config.ts';
import { asignarLetras, generarPaginaPrueba, type FrasePrueba, type MuestraVoz } from '../voz/pruebaCiega.ts';

const { values } = parseArgs({ options: { voces: { type: 'string' }, velocidad: { type: 'string', default: '0.95' }, salida: { type: 'string' } } });
const { voz: cv, emergencia } = cargarConfigVoz();
const catalogo = validarCatalogo(JSON.parse(readFileSync(cv.catalogo, 'utf8')));
const raiz = path.resolve(path.dirname(cv.catalogo), '..', '..');
const frases: FrasePrueba[] = [
  ...(JSON.parse(readFileSync(path.join(raiz, 'config/voz/frases-prueba.json'), 'utf8')) as { frases: FrasePrueba[] }).frases,
  // La frase de crisis es la misma que oirá la persona (no una copia).
  { id: 'crisis', situacion: 'Emergencia (calma y claridad)', texto: respuestaSeguraPara(3, ['ideacion_suicida'], emergencia) },
];
const velocidad = Number(values.velocidad);
const pedidas = values.voces?.split(',').map((x) => x.trim());
const servicios = new ServiciosVoz(cv.servicios);

const candidatas = catalogo.voces.filter((v) => (pedidas ? pedidas.includes(v.id) : true)) as VozConfigurada[];
const omitidas = candidatas.filter((v) => v.voz === 'PENDIENTE');
const voces = candidatas.filter((v) => v.voz !== 'PENDIENTE');
if (voces.length < 2) {
  console.error('Se necesitan al menos 2 voces con identificador. Complete los voice_id de ElevenLabs en config/voz/voces.json o elija otras con --voces.');
  process.exit(1);
}

const fecha = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const salida = path.resolve(values.salida ?? path.join(raiz, 'salida', `prueba-ciega-${fecha}`));
mkdirSync(salida, { recursive: true });

const letras = asignarLetras(voces.map((v) => v.id));
const muestras: MuestraVoz[] = [];
const informe: string[] = [`# Prueba ciega de voces · ${fecha}`, '', `Velocidad: ${velocidad} · Frases: ${frases.length}`, '', '| Voz | Proveedor | Motor | Latencia promedio (ms) | Caracteres | Fallas |', '|---|---|---|---|---|---|'];
const fallidas: string[] = [];

for (const voz of voces) {
  const latencias: number[] = [];
  let caracteres = 0;
  let fallas = 0;
  let ultimoError = '';
  for (const f of frases) {
    try {
      const r = await servicios.sintetizador(voz.proveedor).sintetizar({ texto: prepararParaVoz(f.texto, [emergencia.samu, emergencia.prevencionSuicidio]), voz, velocidad });
      latencias.push(r.latenciaMs);
      caracteres += r.caracteres;
      muestras.push({ letra: letras.get(voz.id)!, frase: f.id, mime: r.mime, audio: r.audio });
    } catch (e) {
      fallas++;
      ultimoError = (e as Error).message;
    }
  }
  const prom = latencias.length ? Math.round(latencias.reduce((a, b) => a + b, 0) / latencias.length) : '-';
  informe.push(`| ${voz.id} | ${voz.proveedor} | ${voz.motor} | ${prom} | ${caracteres} | ${fallas}${fallas ? ` (${ultimoError})` : ''} |`);
  if (fallas === frases.length) fallidas.push(voz.id);
  console.log(`${voz.id}: ${frases.length - fallas}/${frases.length} frases${fallas ? ` · error: ${ultimoError}` : ''}`);
}

// Las voces que fallaron por completo no entran a la prueba.
const letrasUsadas = [...letras.entries()].filter(([id]) => !fallidas.includes(id)).map(([, l]) => l).sort();
const clave = Object.fromEntries([...letras.entries()].filter(([id]) => !fallidas.includes(id)).map(([id, l]) => [l, id]));
writeFileSync(path.join(salida, 'prueba.html'), generarPaginaPrueba({ titulo: `Prueba de voces ${fecha}`, frases, letras: letrasUsadas, muestras: muestras.filter((m) => letrasUsadas.includes(m.letra)) }));
writeFileSync(path.join(salida, 'clave.json'), JSON.stringify({ fecha, velocidad, clave }, null, 2));
if (omitidas.length) informe.push('', `Sin voice_id (omitidas): ${omitidas.map((v) => v.id).join(', ')}`);
informe.push('', 'Para analizar: `npm run voz:resultados -- --clave clave.json <archivos csv>`');
writeFileSync(path.join(salida, 'informe.md'), informe.join('\n') + '\n');
console.log(`\nListo: ${salida}\n  prueba.html (abrir en la tablet) · clave.json (no abrir en la sesión) · informe.md`);
