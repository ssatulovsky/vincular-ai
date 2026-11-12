import { z } from 'zod';
import type { Consultable } from '../db/conexion.ts';
import type { Cifrador } from '../seguridad/cifrado.ts';
import { listarHechos } from '../memoria/hechos.ts';
import { listarMedicamentos } from './medicamentos.ts';

export const esquemaCita = z.object({
  lugar: z.string().trim().min(2).max(160),
  profesional: z.string().trim().max(120).nullable().default(null),
  fecha: z.string().datetime({ offset: true }),
  motivo: z.string().trim().max(300).nullable().default(null),
});

export type DatosCita = z.infer<typeof esquemaCita>;

export interface Cita {
  id: string;
  lugar: string;
  profesional: string | null;
  fecha: Date;
  motivo: string | null;
  hojaPreparadaEn: Date | null;
}

export async function crearCita(bd: Consultable, c: Cifrador, personaId: string, d: DatosCita, autorId: string | null): Promise<string> {
  const r = await bd.query<{ id: string }>(
    'INSERT INTO cita (persona_id, lugar, profesional_cifrado, fecha, motivo_cifrado, creada_por) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [personaId, d.lugar, d.profesional ? c.cifrar(d.profesional) : null, d.fecha, d.motivo ? c.cifrar(d.motivo) : null, autorId],
  );
  return r.rows[0]!.id;
}

export async function cancelarCita(bd: Consultable, personaId: string, id: string): Promise<boolean> {
  const r = await bd.query('UPDATE cita SET cancelada = true WHERE id = $1 AND persona_id = $2 AND NOT cancelada', [id, personaId]);
  return (r.rowCount ?? 0) > 0;
}

export async function citasProximas(bd: Consultable, c: Cifrador, personaId: string, desde: Date, dias = 30): Promise<Cita[]> {
  const r = await bd.query<{ id: string; lugar: string; profesional_cifrado: Buffer | null; fecha: Date; motivo_cifrado: Buffer | null; hoja_preparada_en: Date | null }>(
    `SELECT id, lugar, profesional_cifrado, fecha, motivo_cifrado, hoja_preparada_en FROM cita
      WHERE persona_id = $1 AND NOT cancelada AND fecha BETWEEN $2 AND $2::timestamptz + make_interval(days => $3) ORDER BY fecha`,
    [personaId, desde, dias],
  );
  return r.rows.map((f) => ({
    id: f.id,
    lugar: f.lugar,
    profesional: f.profesional_cifrado ? c.descifrar(f.profesional_cifrado) : null,
    fecha: f.fecha,
    motivo: f.motivo_cifrado ? c.descifrar(f.motivo_cifrado) : null,
    hojaPreparadaEn: f.hoja_preparada_en,
  }));
}

/** Pregunta para el control, con las palabras de la persona. Se asocia a la próxima cita si hay. */
export async function anotarPregunta(bd: Consultable, c: Cifrador, personaId: string, texto: string, origenTurnoId: string | null, ahora: Date): Promise<string> {
  const proxima = await bd.query<{ id: string }>('SELECT id FROM cita WHERE persona_id = $1 AND NOT cancelada AND fecha > $2 ORDER BY fecha LIMIT 1', [personaId, ahora]);
  const r = await bd.query<{ id: string }>('INSERT INTO pregunta_control (persona_id, cita_id, texto_cifrado, origen_turno_id) VALUES ($1, $2, $3, $4) RETURNING id', [
    personaId,
    proxima.rows[0]?.id ?? null,
    c.cifrar(texto),
    origenTurnoId,
  ]);
  return r.rows[0]!.id;
}

export async function preguntasPendientes(bd: Consultable, c: Cifrador, personaId: string): Promise<Array<{ id: string; texto: string; creadaEn: Date }>> {
  const r = await bd.query<{ id: string; texto_cifrado: Buffer; creada_en: Date }>('SELECT id, texto_cifrado, creada_en FROM pregunta_control WHERE persona_id = $1 AND NOT resuelta ORDER BY creada_en', [personaId]);
  return r.rows.map((f) => ({ id: f.id, texto: c.descifrar(f.texto_cifrado), creadaEn: f.creada_en }));
}

export async function resolverPreguntas(bd: Consultable, personaId: string, ids: string[]): Promise<number> {
  const r = await bd.query('UPDATE pregunta_control SET resuelta = true WHERE persona_id = $1 AND id = ANY($2::uuid[]) AND NOT resuelta', [personaId, ids]);
  return r.rowCount ?? 0;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

export interface DatosHoja {
  nombre: string;
  zona: string;
  cita: Cita;
  medicamentos: Array<{ nombre: string; propositoSimple: string | null; dosisTexto: string; horarios: string[]; confirmadas: number; programadas: number }>;
  preguntas: string[];
  saludContada: string[];
  generadaEn: Date;
}

/**
 * Datos de la hoja para el control. Todo sale de lo registrado: medicamentos del equipo de
 * salud, confirmaciones de los últimos 30 días, preguntas y lo que la persona contó sobre su
 * salud (sin lo marcado como privado). No usa el modelo de lenguaje: no puede inventar.
 */
export async function datosHoja(bd: Consultable, c: Cifrador, personaId: string, citaId: string, ahora: Date): Promise<DatosHoja | null> {
  const cita = await bd.query<{ id: string; lugar: string; profesional_cifrado: Buffer | null; fecha: Date; motivo_cifrado: Buffer | null; hoja_preparada_en: Date | null }>(
    'SELECT id, lugar, profesional_cifrado, fecha, motivo_cifrado, hoja_preparada_en FROM cita WHERE id = $1 AND persona_id = $2 AND NOT cancelada',
    [citaId, personaId],
  );
  const f = cita.rows[0];
  if (!f) return null;
  const p = await bd.query<{ nombre_cifrado: Buffer; zona_horaria: string }>('SELECT nombre_cifrado, zona_horaria FROM persona WHERE id = $1', [personaId]);
  const meds = await listarMedicamentos(bd, c, personaId);
  const adherencia = await bd.query<{ medicamento_id: string; confirmadas: string; programadas: string }>(
    `SELECT e.medicamento_id, count(*) FILTER (WHERE e.estado = 'confirmada') AS confirmadas,
            count(*) FILTER (WHERE e.estado IN ('confirmada', 'omitida', 'sin_respuesta')) AS programadas
       FROM evento_dosis e JOIN medicamento m ON m.id = e.medicamento_id
      WHERE m.persona_id = $1 AND e.programada_en BETWEEN $2::timestamptz - interval '30 days' AND $2 GROUP BY e.medicamento_id`,
    [personaId, ahora],
  );
  const ad = new Map(adherencia.rows.map((x) => [x.medicamento_id, { confirmadas: Number(x.confirmadas), programadas: Number(x.programadas) }]));
  const salud = (await listarHechos(bd, c, personaId, { incluirPrivados: false })).filter((h) => h.capa === 'salud' && h.estado === 'confirmado');
  return {
    nombre: c.descifrar(p.rows[0]!.nombre_cifrado),
    zona: p.rows[0]!.zona_horaria,
    cita: { id: f.id, lugar: f.lugar, profesional: f.profesional_cifrado ? c.descifrar(f.profesional_cifrado) : null, fecha: f.fecha, motivo: f.motivo_cifrado ? c.descifrar(f.motivo_cifrado) : null, hojaPreparadaEn: f.hoja_preparada_en },
    medicamentos: meds.map((m) => ({ nombre: m.nombre, propositoSimple: m.propositoSimple, dosisTexto: m.dosisTexto, horarios: m.horarios, ...(ad.get(m.id) ?? { confirmadas: 0, programadas: 0 }) })),
    preguntas: (await preguntasPendientes(bd, c, personaId)).map((x) => x.texto),
    saludContada: salud.map((h) => h.contenido),
    generadaEn: ahora,
  };
}

/** Hoja de una página, en letra grande, para imprimir o mostrar en el control. */
export function hojaHtml(d: DatosHoja): string {
  const fecha = (x: Date, conHora = true) =>
    new Intl.DateTimeFormat('es-CL', { timeZone: d.zona, weekday: 'long', day: 'numeric', month: 'long', ...(conHora ? { hour: '2-digit', minute: '2-digit' } : {}) }).format(x);
  const lista = (xs: string[], vacio: string) => (xs.length ? `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : `<p class="vacio">${esc(vacio)}</p>`);
  const meds = d.medicamentos.length
    ? `<table><thead><tr><th>Remedio</th><th>Cómo lo tomo</th><th>Últimos 30 días</th></tr></thead><tbody>${d.medicamentos
        .map(
          (m) =>
            `<tr><td><strong>${esc(m.nombre)}</strong>${m.propositoSimple ? `<br>${esc(m.propositoSimple)}` : ''}</td><td>${esc(m.dosisTexto)}<br>${m.horarios.map(esc).join(' · ')}</td><td>${
              m.programadas ? `Confirmé ${m.confirmadas} de ${m.programadas} tomas` : 'Sin registro'
            }</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="vacio">No hay remedios registrados.</p>';
  return `<!doctype html>
<html lang="es-CL"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Para mi control · ${esc(fecha(d.cita.fecha, false))}</title>
<style>
  @page { size: A4; margin: 14mm; }
  body { font-family: "Atkinson Hyperlegible", Verdana, sans-serif; color: #12221B; font-size: 15pt; line-height: 1.4; max-width: 760px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 22pt; margin: 0 0 4px; }
  h2 { font-size: 15pt; margin: 18px 0 6px; padding-bottom: 3px; border-bottom: 2px solid #1E5A47; }
  .cita { font-size: 14pt; margin: 0; }
  table { width: 100%; border-collapse: collapse; font-size: 13pt; }
  th, td { text-align: left; vertical-align: top; padding: 6px 8px; border-bottom: 1px solid #C9D6D0; }
  ul { margin: 0; padding-left: 1.2em; }
  .vacio { color: #3B5148; font-style: italic; margin: 0; }
  footer { margin-top: 20px; font-size: 10.5pt; color: #3B5148; }
  @media print { body { margin: 0; } }
</style></head>
<body>
  <h1>${esc(d.nombre)}</h1>
  <p class="cita">Control: ${esc(fecha(d.cita.fecha))}<br>${esc(d.cita.lugar)}${d.cita.profesional ? ` · ${esc(d.cita.profesional)}` : ''}${d.cita.motivo ? `<br>Motivo: ${esc(d.cita.motivo)}` : ''}</p>
  <h2>Lo que quiero preguntar</h2>
  ${lista(d.preguntas, 'No anoté preguntas.')}
  <h2>Mis remedios</h2>
  ${meds}
  <h2>Lo que he contado sobre mi salud</h2>
  ${lista(d.saludContada, 'Nada registrado.')}
  <footer>Hoja preparada por Vincular-IA el ${esc(fecha(d.generadaEn))} con lo que usted contó y lo que registró su equipo de salud. No reemplaza las indicaciones de su médico.</footer>
</body></html>`;
}
