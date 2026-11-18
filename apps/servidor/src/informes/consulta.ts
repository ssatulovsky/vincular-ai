import type { Consultable } from '../db/conexion.ts';
import type { Cifrador } from '../seguridad/cifrado.ts';
import { datosHoja } from '../medicacion/citas.ts';
import { resultadosTamizaje } from '../tamizaje/tamizaje.ts';
import { lineaBase, metricasPorSemana } from './evolucion.ts';
import { comparable, type InformeSesion } from './sesion.ts';

/**
 * Informe para consulta (especificación, «Tipos de informe»): antes de un control médico o
 * psicológico, síntesis del período, cambios relevantes y preguntas de la persona, para el
 * profesional tratante, CON AUTORIZACIÓN de la persona.
 *
 * Lo arma el código con lo registrado, sin modelo de lenguaje: no puede inventar. Nunca incluye
 * transcripciones, hipótesis, plan ni lecturas teóricas, ni temas que la persona marcó como
 * privados (estos solo los ve el supervisor). Si se omitió algo por privado, el informe lo dice.
 */

const DIA = 86_400_000;
const MAX_PERIODO_DIAS = 90;

export interface Autorizacion {
  destinatario: string;
  forma: 'verbal' | 'escrita';
  registradaPor: string;
  registradaEn: Date;
}

export interface Observacion {
  fecha: Date;
  texto: string;
  citas: string[];
}

export interface InformeConsulta {
  nombre: string;
  edad: number | null;
  zona: string;
  cita: { fecha: Date; lugar: string; profesional: string | null; motivo: string | null };
  periodo: { desde: Date; hasta: Date; motivo: string };
  autorizacion: Autorizacion;
  medicamentos: Awaited<ReturnType<typeof datosHoja>> extends infer T ? (T extends { medicamentos: infer M } ? M : never) : never;
  preguntas: string[];
  saludContada: string[];
  salud: Observacion[];
  funcionamiento: Observacion[];
  evolucion: { animo: number | null; animoBase: number | null; nochesMalDormidas: number; contactosSemana: number | null; contactosBase: number | null; semanas: number };
  alertas: Array<{ fecha: Date; nivel: number; categorias: string[]; acusada: boolean }>;
  tamizajes: Array<{ nombre: string; puntaje: number | null; maximo: number | null; corte: number | null; elevado: boolean | null; fecha: Date }>;
  omitidasPorPrivadas: number;
}

const PALABRAS_COMUNES = new Set(['porque', 'cuando', 'siempre', 'tambien', 'despues', 'entonces', 'todavia', 'quiere', 'quiero', 'tiene', 'tengo', 'estoy', 'esta', 'semana', 'persona', 'cuenta', 'conto', 'refiere']);

/** Lo privado de la persona, para filtrar: citas, el texto de los turnos de origen y sus palabras distintivas. */
async function marcasPrivadas(bd: Consultable, c: Cifrador, personaId: string) {
  const r = await bd.query<{ contenido_cifrado: Buffer; cita_cifrada: Buffer | null; turno: Buffer | null }>(
    `SELECT h.contenido_cifrado, h.cita_cifrada, t.texto_cifrado AS turno FROM hecho_memoria h LEFT JOIN turno t ON t.id = h.origen_turno_id
      WHERE h.persona_id = $1 AND h.privado AND h.vigente`,
    [personaId],
  );
  const citas: string[] = [];
  const turnos: string[] = [];
  const palabras = new Set<string>();
  for (const f of r.rows) {
    if (f.cita_cifrada) citas.push(comparable(c.descifrar(f.cita_cifrada)));
    if (f.turno) turnos.push(comparable(c.descifrar(f.turno)));
    for (const p of comparable(c.descifrar(f.contenido_cifrado)).split(' ')) if (p.length >= 6 && !PALABRAS_COMUNES.has(p)) palabras.add(p);
  }
  return { citas, turnos, palabras };
}

/**
 * ¿Toca un tema privado? Criterio deliberadamente estricto: ante la duda se omite (y se avisa).
 */
export function tocaPrivado(o: { texto: string; citas: readonly string[] }, m: { citas: readonly string[]; turnos: readonly string[]; palabras: ReadonlySet<string> }): boolean {
  for (const ci of o.citas.map(comparable)) {
    if (ci.length < 3) continue;
    if (m.turnos.some((t) => t.includes(ci))) return true;
    if (m.citas.some((p) => p.includes(ci) || ci.includes(p))) return true;
  }
  const palabras = new Set(comparable(`${o.texto} ${o.citas.join(' ')}`).split(' '));
  for (const p of m.palabras) if (palabras.has(p)) return true;
  return false;
}

export async function datosInformeConsulta(bd: Consultable, c: Cifrador, personaId: string, citaId: string, autorizacion: Autorizacion, ahora = new Date()): Promise<InformeConsulta | null> {
  const hoja = await datosHoja(bd, c, personaId, citaId, ahora);
  if (!hoja) return null;
  const p = await bd.query<{ fecha_nacimiento: Date | null }>('SELECT fecha_nacimiento FROM persona WHERE id = $1', [personaId]);
  const nac = p.rows[0]?.fecha_nacimiento ?? null;
  const edad = nac ? Math.floor((ahora.getTime() - nac.getTime()) / (365.25 * DIA)) : null;

  // Período: desde el control anterior (si lo hubo) hasta hoy; como máximo 90 días.
  const anterior = await bd.query<{ fecha: Date }>(
    'SELECT fecha FROM cita WHERE persona_id = $1 AND id <> $2 AND NOT cancelada AND fecha < $3 ORDER BY fecha DESC LIMIT 1',
    [personaId, citaId, ahora],
  );
  const tope = new Date(ahora.getTime() - MAX_PERIODO_DIAS * DIA);
  const desdeAnterior = anterior.rows[0]?.fecha;
  const desde = desdeAnterior && desdeAnterior > tope ? desdeAnterior : desdeAnterior ? tope : new Date(ahora.getTime() - 30 * DIA);
  const motivoPeriodo = desdeAnterior && desdeAnterior > tope ? 'desde el control anterior' : desdeAnterior ? `últimos ${MAX_PERIODO_DIAS} días` : 'últimos 30 días';

  const privado = await marcasPrivadas(bd, c, personaId);
  let omitidas = 0;
  const informes = await bd.query<{ inicio: Date; contenido_cifrado: Buffer }>(
    `SELECT s.inicio, i.contenido_cifrado FROM informe_sesion i JOIN sesion_conversacion s ON s.id = i.sesion_id
      WHERE s.persona_id = $1 AND i.estado_validacion = 'valido' AND s.inicio >= $2 AND s.inicio <= $3 ORDER BY s.inicio`,
    [personaId, desde, ahora],
  );
  const salud: Observacion[] = [];
  const funcionamiento: Observacion[] = [];
  const vistos = new Set<string>();
  for (const f of informes.rows) {
    const inf = c.descifrarJson(f.contenido_cifrado) as InformeSesion;
    for (const [destino, obs] of [[salud, inf.salud.observado], [funcionamiento, inf.funcionamiento_cotidiano.observado]] as const) {
      for (const o of obs) {
        if (tocaPrivado(o, privado)) {
          omitidas++;
          continue;
        }
        const clave = comparable(o.texto);
        if (vistos.has(clave)) continue;
        vistos.add(clave);
        destino.push({ fecha: f.inicio, texto: o.texto, citas: o.citas });
      }
    }
  }

  const semanas = await metricasPorSemana(bd, c, personaId, ahora);
  const base = lineaBase(semanas);
  const delPeriodo = semanas.filter((s) => new Date(`${s.semana}T12:00:00Z`).getTime() + 7 * DIA > desde.getTime());
  const animos = delPeriodo.filter((s) => s.animo.promedio !== null);
  const conSesiones = delPeriodo.filter((s) => s.sesiones > 0);
  const redondear = (n: number) => Math.round(n * 10) / 10;

  const alertas = await bd.query<{ creado_en: Date; nivel: number; categorias: string[]; acusado_en: Date | null }>(
    'SELECT creado_en, nivel, categorias, acusado_en FROM evento_riesgo WHERE persona_id = $1 AND nivel >= 2 AND creado_en >= $2 AND creado_en <= $3 ORDER BY creado_en',
    [personaId, desde, ahora],
  );
  const tamizajes = (await resultadosTamizaje(bd, personaId)).filter((t) => t.aplicadoEn >= desde);

  return {
    nombre: hoja.nombre,
    edad,
    zona: hoja.zona,
    cita: { fecha: hoja.cita.fecha, lugar: hoja.cita.lugar, profesional: hoja.cita.profesional, motivo: hoja.cita.motivo },
    periodo: { desde, hasta: ahora, motivo: motivoPeriodo },
    autorizacion,
    medicamentos: hoja.medicamentos,
    preguntas: hoja.preguntas,
    saludContada: hoja.saludContada,
    salud: salud.slice(-15),
    funcionamiento: funcionamiento.slice(-10),
    evolucion: {
      animo: animos.length ? redondear(animos.reduce((a, s) => a + (s.animo.promedio ?? 0), 0) / animos.length) : null,
      animoBase: base?.animoPromedio ?? null,
      nochesMalDormidas: delPeriodo.reduce((a, s) => a + s.suenoMalo, 0),
      contactosSemana: conSesiones.length ? redondear(conSesiones.reduce((a, s) => a + s.contactosHumanos, 0) / conSesiones.length) : null,
      contactosBase: base?.contactosSemana ?? null,
      semanas: delPeriodo.length,
    },
    alertas: alertas.rows.map((a) => ({ fecha: a.creado_en, nivel: a.nivel, categorias: a.categorias, acusada: a.acusado_en !== null })),
    tamizajes: tamizajes.map((t) => ({ nombre: t.nombre, puntaje: t.puntaje, maximo: t.maximo, corte: t.corte, elevado: t.elevado, fecha: t.aplicadoEn })),
    omitidasPorPrivadas: omitidas,
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** Documento imprimible (A4), sobrio, para el profesional tratante. */
export function htmlInformeConsulta(d: InformeConsulta): string {
  const f = (x: Date, hora = false) => new Intl.DateTimeFormat('es-CL', { timeZone: d.zona, day: 'numeric', month: 'long', year: 'numeric', ...(hora ? { hour: '2-digit', minute: '2-digit' } : {}) }).format(x);
  const corto = (x: Date) => new Intl.DateTimeFormat('es-CL', { timeZone: d.zona, day: 'numeric', month: 'short' }).format(x);
  const lista = (xs: string[], vacio: string) => (xs.length ? `<ul>${xs.join('')}</ul>` : `<p class="vacio">${esc(vacio)}</p>`);
  const obs = (xs: Observacion[]) => xs.map((o) => `<li><span class="fecha">${esc(corto(o.fecha))}</span> ${esc(o.texto)}${o.citas.length ? ` <span class="cita">«${o.citas.map(esc).join('», «')}»</span>` : ''}</li>`);
  const comp = (v: number | null, base: number | null, unidad = '') => (v === null ? 'sin registros' : `${v}${unidad}${base !== null ? ` (línea base: ${base}${unidad})` : ''}`);
  const e = d.evolucion;
  return `<!doctype html><html lang="es-CL"><head><meta charset="utf-8"><title>Informe para consulta · ${esc(d.nombre)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  body { font: 11pt/1.45 "Atkinson Hyperlegible", Verdana, sans-serif; color: #12221B; max-width: 180mm; margin: 0 auto; }
  h1 { font-size: 17pt; margin: 0 0 2mm; } h2 { font-size: 12pt; margin: 6mm 0 2mm; border-bottom: 1px solid #C9D4CE; padding-bottom: 1mm; }
  .datos { color: #3B5148; } .confidencial { font-weight: 700; color: #A3121A; }
  .autorizacion { background: #EEF2EF; padding: 3mm 4mm; border-left: 3px solid #1E5A47; margin: 4mm 0; }
  ul { margin: 0; padding-left: 5mm; } li { margin: 1mm 0; } .fecha { color: #3B5148; font-size: 9.5pt; } .cita { color: #1E5A47; }
  table { border-collapse: collapse; width: 100%; } td, th { text-align: left; padding: 1.5mm 2mm; border-bottom: 1px solid #E1E8E4; font-size: 10pt; }
  .vacio { color: #5B6E66; font-style: italic; } .nota { color: #3B5148; font-size: 9.5pt; margin-top: 6mm; }
</style></head><body>
<p class="confidencial">Confidencial · información de salud</p>
<h1>Informe para consulta</h1>
<p class="datos">${esc(d.nombre)}${d.edad !== null ? `, ${d.edad} años` : ''} · Control del ${esc(f(d.cita.fecha, true))} en ${esc(d.cita.lugar)}${d.cita.profesional ? ` con ${esc(d.cita.profesional)}` : ''}${d.cita.motivo ? ` · Motivo: ${esc(d.cita.motivo)}` : ''}</p>
<p class="datos">Período: ${esc(f(d.periodo.desde))} al ${esc(f(d.periodo.hasta))} (${esc(d.periodo.motivo)}).</p>
<div class="autorizacion">${esc(d.nombre.split(' ')[0]!)} autorizó (${d.autorizacion.forma === 'escrita' ? 'por escrito' : 'verbalmente'}) compartir este informe con <strong>${esc(d.autorizacion.destinatario)}</strong>. Registrado por ${esc(d.autorizacion.registradaPor)} el ${esc(f(d.autorizacion.registradaEn, true))}</div>
<p class="nota" style="margin-top:0">Síntesis de lo registrado por Vincular-IA, un acompañante conversacional supervisado por un equipo de salud mental. No es un diagnóstico. Las frases entre comillas son textuales de la persona.</p>

<h2>Preguntas de la persona para este control</h2>
${lista(d.preguntas.map((p) => `<li>${esc(p)}</li>`), 'No anotó preguntas.')}

<h2>Medicación y adherencia (últimos 30 días)</h2>
${d.medicamentos.length ? `<table><tr><th>Medicamento</th><th>Indicación</th><th>Horario</th><th>Confirmadas</th></tr>${d.medicamentos.map((m) => `<tr><td>${esc(m.nombre)}${m.propositoSimple ? ` <span class="fecha">(${esc(m.propositoSimple)})</span>` : ''}</td><td>${esc(m.dosisTexto)}</td><td>${esc(m.horarios.join(', '))}</td><td>${m.programadas ? `${m.confirmadas} de ${m.programadas}` : 'sin registro'}</td></tr>`).join('')}</table>` : '<p class="vacio">Sin medicamentos registrados.</p>'}

<h2>Salud: lo que contó en el período</h2>
${lista([...obs(d.salud), ...d.saludContada.map((s) => `<li>${esc(s)} <span class="fecha">(dato confirmado por la persona)</span></li>`)], 'No contó síntomas ni molestias en el período.')}

<h2>Vida diaria: sueño, alimentación, actividad</h2>
${lista(obs(d.funcionamiento), 'Sin registros en el período.')}

<h2>Ánimo y contacto con otras personas</h2>
<ul>
  <li>Ánimo promedio (−2 muy bajo a 2 muy bueno): ${esc(comp(e.animo, e.animoBase))}.</li>
  <li>Noches de mal dormir que contó: ${e.nochesMalDormidas}.</li>
  <li>Contactos con otras personas por semana: ${esc(comp(e.contactosSemana, e.contactosBase))}.</li>
</ul>

<h2>Señales de alerta registradas</h2>
${lista(d.alertas.map((a) => `<li><span class="fecha">${esc(corto(a.fecha))}</span> Nivel ${a.nivel}${a.categorias.length ? `: ${esc(a.categorias.map((x) => x.replaceAll('_', ' ')).join(', '))}` : ''}${a.acusada ? '' : ' (sin acuse)'}</li>`), 'Sin alertas de nivel 2 o 3 en el período.')}

<h2>Tamizajes</h2>
${lista(d.tamizajes.map((t) => `<li><span class="fecha">${esc(corto(t.fecha))}</span> ${esc(t.nombre)}: ${t.puntaje} de ${t.maximo}${t.elevado ? ` (sobre el corte de ${t.corte})` : ''}. Aplicado conversando; orientativo.</li>`), 'Sin tamizajes en el período.')}

${d.omitidasPorPrivadas ? `<p class="nota">Se omitieron ${d.omitidasPorPrivadas} ${d.omitidasPorPrivadas === 1 ? 'registro' : 'registros'} que tocan temas que la persona marcó como privados.</p>` : ''}
<p class="nota">Equipo Vincular-IA · generado el ${esc(f(d.autorizacion.registradaEn, true))}</p>
</body></html>`;
}
