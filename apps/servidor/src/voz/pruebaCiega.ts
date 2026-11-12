import { randomInt } from 'node:crypto';
import { celdasCsv } from '../utilidades/csv.ts';

/**
 * Prueba ciega de voces para el co-diseño con personas mayores.
 *
 * Genera UNA página HTML autocontenida (los audios van dentro) que funciona sin internet en
 * cualquier tablet o computador. Cada voz aparece con una letra; qué voz es cada letra queda en
 * un archivo aparte (`clave.json`) que no se abre durante la sesión. Las calificaciones se
 * guardan en el navegador y se descargan como CSV.
 */

export interface FrasePrueba {
  id: string;
  situacion: string;
  texto: string;
}

export interface MuestraVoz {
  letra: string;
  frase: string;
  mime: string;
  audio: Buffer;
}

/** Asigna letras al azar a las voces (A, B, C…). */
export function asignarLetras(ids: readonly string[], azar: (max: number) => number = (m) => randomInt(m)): Map<string, string> {
  const mezcla = [...ids];
  for (let i = mezcla.length - 1; i > 0; i--) {
    const j = azar(i + 1);
    [mezcla[i], mezcla[j]] = [mezcla[j]!, mezcla[i]!];
  }
  return new Map(mezcla.map((id, i) => [id, String.fromCharCode(65 + i)]));
}

const escapar = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function generarPaginaPrueba(p: { titulo: string; frases: readonly FrasePrueba[]; letras: readonly string[]; muestras: readonly MuestraVoz[] }): string {
  const datos = {
    frases: p.frases.map((f) => ({ id: f.id, situacion: f.situacion, texto: f.texto })),
    letras: p.letras,
    audios: Object.fromEntries(p.muestras.map((m) => [`${m.letra}|${m.frase}`, `data:${m.mime};base64,${m.audio.toString('base64')}`])),
  };
  // El JSON va en un <script type="application/json">: se neutraliza "</" para no cerrar la etiqueta.
  const json = JSON.stringify(datos).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="es-CL">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapar(p.titulo)}</title>
<style>
  :root { --fondo:#E7EEEA; --tinta:#12221B; --suave:#3B5148; --botella:#1E5A47; --claro:#CFE1D8; --mostaza:#E2A41F; --blanco:#FFFFFF; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--fondo); color: var(--tinta); font-family: "Atkinson Hyperlegible", Verdana, sans-serif; font-size: 22px; line-height: 1.45; }
  main { max-width: 860px; margin: 0 auto; padding: 24px 20px 64px; }
  h1 { font-size: 30px; margin: 0 0 8px; }
  h2 { font-size: 26px; margin: 0 0 6px; }
  p { margin: 0 0 14px; }
  .suave { color: var(--suave); font-size: 19px; }
  .cita { background: var(--blanco); border-radius: 16px; padding: 16px 20px; margin: 10px 0 22px; font-size: 21px; }
  .voz { background: var(--blanco); border-radius: 18px; padding: 16px 18px; margin: 0 0 14px; display: grid; gap: 10px; }
  .voz header { display: flex; align-items: center; gap: 14px; }
  .letra { font-size: 30px; font-weight: 700; width: 52px; height: 52px; border-radius: 50%; background: var(--claro); display: grid; place-items: center; flex: none; }
  button { font: inherit; font-weight: 700; border-radius: 14px; border: 3px solid var(--botella); background: var(--blanco); color: var(--botella); min-height: 56px; padding: 0 20px; cursor: pointer; }
  button.principal { background: var(--botella); color: var(--blanco); }
  button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 4px solid var(--mostaza); outline-offset: 3px; }
  .escala { display: grid; grid-template-columns: 10.5em repeat(5, 1fr); gap: 6px; align-items: center; }
  .escala span { font-size: 18px; color: var(--suave); }
  .escala button { min-height: 48px; padding: 0; font-size: 20px; }
  .escala button[aria-pressed="true"] { background: var(--botella); color: var(--blanco); }
  .navegacion { display: flex; justify-content: space-between; gap: 12px; margin-top: 22px; }
  input, textarea { font: inherit; padding: 12px 14px; border-radius: 12px; border: 3px solid var(--suave); width: 100%; }
  .oculto { display: none; }
  @media (max-width: 560px) { .escala { grid-template-columns: repeat(5, 1fr); } .escala span { grid-column: 1 / -1; } }
</style>
</head>
<body>
<main id="app" aria-live="polite"></main>
<script type="application/json" id="datos">${json}</script>
<script>
(() => {
  const D = JSON.parse(document.getElementById('datos').textContent);
  const CLAVE = 'vincular.pruebaCiega.' + document.title;
  const PREGUNTAS = [['naturalidad', '¿Suena como una persona?'], ['claridad', '¿Se entiende bien?'], ['calidez', '¿Le transmite cercanía?']];
  const cargar = () => { try { return JSON.parse(localStorage.getItem(CLAVE)) || null; } catch { return null; } };
  const guardar = () => { try { localStorage.setItem(CLAVE, JSON.stringify(E)); } catch {} };
  let E = cargar() || { participante: '', paso: -1, notas: {}, preferida: '', comentario: '', orden: {} };
  const app = document.getElementById('app');
  let audio = null;

  function sonar(letra, frase) {
    if (audio) audio.pause();
    audio = new Audio(D.audios[letra + '|' + frase]);
    audio.play();
  }
  // Orden distinto de las voces en cada frase, para que ninguna gane por ir primero.
  function orden(frase) {
    if (!E.orden[frase]) { const o = D.letras.slice(); for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; } E.orden[frase] = o; guardar(); }
    return E.orden[frase];
  }
  const el = (tag, props = {}, ...hijos) => { const n = Object.assign(document.createElement(tag), props); n.append(...hijos); return n; };

  function inicio() {
    const campo = el('input', { value: E.participante, autocomplete: 'off', placeholder: 'Por ejemplo: P07' });
    app.replaceChildren(
      el('h1', {}, 'Elegir la voz del compañero'),
      el('p', {}, 'Va a escuchar ' + D.letras.length + ' voces diciendo ' + D.frases.length + ' frases. Después de cada una, cuéntenos qué le pareció. No hay respuestas correctas.'),
      el('p', { className: 'suave' }, 'Código de la persona que participa (sin nombres):'),
      campo,
      el('div', { className: 'navegacion' }, el('span'), el('button', { className: 'principal', onclick: () => { if (!campo.value.trim()) return campo.focus(); E.participante = campo.value.trim(); E.paso = 0; guardar(); pintar(); } }, 'Empezar')),
    );
  }

  function frase(i) {
    const f = D.frases[i];
    const voces = orden(f.id).map((letra) => {
      const notas = (E.notas[f.id] ||= {})[letra] ||= {};
      const escalas = PREGUNTAS.map(([clave, pregunta]) => {
        const botones = [1, 2, 3, 4, 5].map((n) => el('button', { type: 'button', textContent: String(n), ariaLabel: pregunta + ' ' + n + ' de 5', ariaPressed: String(notas[clave] === n), onclick: () => { notas[clave] = n; guardar(); pintar(); } }));
        return el('div', { className: 'escala' }, el('span', {}, pregunta), ...botones);
      });
      return el('section', { className: 'voz' }, el('header', {}, el('div', { className: 'letra', ariaHidden: 'true' }, letra), el('button', { className: 'principal', onclick: () => sonar(letra, f.id) }, 'Escuchar la voz ' + letra)), ...escalas);
    });
    app.replaceChildren(
      el('p', { className: 'suave' }, 'Frase ' + (i + 1) + ' de ' + D.frases.length + ': ' + f.situacion),
      el('div', { className: 'cita' }, f.texto),
      ...voces,
      el('p', { className: 'suave' }, '1 = nada, 5 = mucho.'),
      el('div', { className: 'navegacion' },
        el('button', { onclick: () => { E.paso = i - 1; guardar(); pintar(); } }, i === 0 ? 'Volver al inicio' : 'Frase anterior'),
        el('button', { className: 'principal', onclick: () => { E.paso = i + 1; guardar(); pintar(); } }, i + 1 === D.frases.length ? 'Terminar' : 'Siguiente frase')),
    );
    scrollTo(0, 0);
  }

  function final() {
    const f0 = D.frases[0].id;
    const opciones = D.letras.map((letra) => el('div', { className: 'voz' }, el('header', {},
      el('div', { className: 'letra', ariaHidden: 'true' }, letra),
      el('button', { onclick: () => sonar(letra, f0) }, 'Escuchar ' + letra),
      el('button', { className: E.preferida === letra ? 'principal' : '', ariaPressed: String(E.preferida === letra), onclick: () => { E.preferida = letra; guardar(); pintar(); } }, E.preferida === letra ? 'Elegida' : 'Elegir esta'))));
    const comentario = el('textarea', { rows: 3, value: E.comentario, oninput: (ev) => { E.comentario = ev.target.value; guardar(); } });
    app.replaceChildren(
      el('h2', {}, '¿Con cuál voz le gustaría conversar todos los días?'),
      ...opciones,
      el('p', { className: 'suave' }, '¿Algo más que quiera contarnos sobre las voces?'),
      comentario,
      el('div', { className: 'navegacion' },
        el('button', { onclick: () => { E.paso = D.frases.length - 1; guardar(); pintar(); } }, 'Volver'),
        el('button', { className: 'principal', onclick: descargar }, 'Descargar resultados')),
      el('div', { className: 'navegacion' }, el('span'), el('button', { onclick: () => { if (confirm('¿Empezar con otra persona? Descargue antes los resultados.')) { E = { participante: '', paso: -1, notas: {}, preferida: '', comentario: '', orden: {} }; guardar(); pintar(); } } }, 'Siguiente participante')),
    );
  }

  function descargar() {
    const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const filas = [['participante', 'frase', 'voz', 'naturalidad', 'claridad', 'calidez', 'preferida', 'comentario'].join(',')];
    for (const f of D.frases) for (const letra of D.letras) {
      const n = (E.notas[f.id] || {})[letra] || {};
      filas.push([q(E.participante), q(f.id), q(letra), n.naturalidad ?? '', n.claridad ?? '', n.calidez ?? '', q(E.preferida === letra ? 'si' : ''), q('')].join(','));
    }
    filas.push([q(E.participante), q('_final'), q(E.preferida), '', '', '', q('si'), q(E.comentario)].join(','));
    const a = el('a', { href: URL.createObjectURL(new Blob(['\\ufeff' + filas.join('\\n')], { type: 'text/csv' })), download: 'prueba-voces-' + E.participante + '.csv' });
    document.body.append(a); a.click(); a.remove();
  }

  function pintar() { if (E.paso < 0) inicio(); else if (E.paso >= D.frases.length) final(); else frase(E.paso); }
  pintar();
})();
</script>
</body>
</html>
`;
}

export interface FilaResultado {
  participante: string;
  frase: string;
  voz: string;
  naturalidad: number | null;
  claridad: number | null;
  calidez: number | null;
  preferida: boolean;
}

/** Lee un CSV descargado de la página (formato fijo, con comillas). */
export function leerCsvResultados(csv: string): FilaResultado[] {
  const lineas = csv.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean).slice(1);
  return lineas
    .map(celdasCsv)
    .filter((c) => c[1] !== '_final')
    .map((c) => {
      const num = (v: string | undefined) => (v && /^[1-5]$/.test(v) ? Number(v) : null);
      return { participante: c[0] ?? '', frase: c[1] ?? '', voz: c[2] ?? '', naturalidad: num(c[3]), claridad: num(c[4]), calidez: num(c[5]), preferida: c[6] === 'si' };
    });
}

export interface ResumenVoz {
  letra: string;
  vozId: string;
  naturalidad: number | null;
  claridad: number | null;
  calidez: number | null;
  calificaciones: number;
  preferidaPor: number;
}

/** Promedios por voz y cuántas personas la eligieron, ya con la clave descubierta. */
export function resumirResultados(filas: readonly FilaResultado[], clave: Record<string, string>): ResumenVoz[] {
  const prom = (xs: Array<number | null>) => {
    const v = xs.filter((x): x is number => x !== null);
    return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null;
  };
  return Object.entries(clave)
    .map(([letra, vozId]) => {
      const d = filas.filter((f) => f.voz === letra);
      return {
        letra,
        vozId,
        naturalidad: prom(d.map((f) => f.naturalidad)),
        claridad: prom(d.map((f) => f.claridad)),
        calidez: prom(d.map((f) => f.calidez)),
        calificaciones: d.filter((f) => f.naturalidad !== null || f.claridad !== null || f.calidez !== null).length,
        preferidaPor: new Set(d.filter((f) => f.preferida).map((f) => f.participante)).size,
      };
    })
    .sort((a, b) => b.preferidaPor - a.preferidaPor || (b.naturalidad ?? 0) - (a.naturalidad ?? 0));
}
