import type { Bd, Consultable } from '../db/conexion.ts';
import { transaccion } from '../db/conexion.ts';
import { iniciarEscalamiento } from '../escalamiento/motor.ts';
import { comparable } from '../informes/sesion.ts';
import type { Cifrador } from '../seguridad/cifrado.ts';
import { INSTRUMENTOS, puntuar, type ClaveInstrumento, type Instrumento, type Respuesta } from './instrumentos.ts';

/** Una respuesta, con la frase literal de la persona que la sostiene. */
interface RespuestaRegistrada {
  respuesta: Respuesta;
  cita: string;
  turnoId: string;
  sesionId: string;
  en: string;
}
type Respuestas = Record<number, RespuestaRegistrada>;

export class ErrorTamizaje extends Error {
  constructor(
    readonly estado: number,
    mensaje: string,
  ) {
    super(mensaje);
  }
}

export interface TamizajeEnCurso {
  id: string;
  instrumento: Instrumento;
  respuestas: Respuestas;
  pendientes: Instrumento['items'];
  iniciadoEn: Date;
}

export async function iniciarTamizaje(bd: Consultable, cifrador: Cifrador, personaId: string, instrumento: ClaveInstrumento, cuentaId: string): Promise<string> {
  const r = await bd.query<{ id: string }>(
    `INSERT INTO tamizaje (persona_id, instrumento, respuestas_cifradas, iniciado_por) VALUES ($1, $2, $3, $4)
     ON CONFLICT (persona_id, instrumento) WHERE estado = 'en_curso' DO NOTHING RETURNING id`,
    [personaId, instrumento, cifrador.cifrarJson({}), cuentaId],
  );
  if (!r.rows[0]) throw new ErrorTamizaje(409, 'Ya hay un tamizaje de este tipo en curso');
  return r.rows[0].id;
}

export async function cancelarTamizaje(bd: Consultable, personaId: string, tamizajeId: string): Promise<boolean> {
  const r = await bd.query(`UPDATE tamizaje SET estado = 'cancelado', terminado_en = now() WHERE id = $1 AND persona_id = $2 AND estado = 'en_curso'`, [tamizajeId, personaId]);
  return (r.rowCount ?? 0) > 0;
}

export async function tamizajesEnCurso(bd: Consultable, cifrador: Cifrador, personaId: string): Promise<TamizajeEnCurso[]> {
  const r = await bd.query<{ id: string; instrumento: ClaveInstrumento; respuestas_cifradas: Buffer; iniciado_en: Date }>(
    `SELECT id, instrumento, respuestas_cifradas, iniciado_en FROM tamizaje WHERE persona_id = $1 AND estado = 'en_curso' ORDER BY iniciado_en`,
    [personaId],
  );
  return r.rows.map((f) => {
    const instrumento = INSTRUMENTOS[f.instrumento];
    const respuestas = cifrador.descifrarJson<Respuestas>(f.respuestas_cifradas);
    return { id: f.id, instrumento, respuestas, pendientes: instrumento.items.filter((i) => !respuestas[i.numero]), iniciadoEn: f.iniciado_en };
  });
}

export interface ContextoRespuesta {
  bd: Bd;
  cifrador: Cifrador;
  personaId: string;
  sesionId: string;
  turnoPersonaId: string;
  /** Lo que la persona acaba de decir: la cita tiene que estar ahí. */
  textoPersona: string;
  ahora: Date;
}

export type ResultadoRespuesta =
  | { registrada: true; quedan: number; siguiente: string | null; completado: false }
  | { registrada: true; completado: true; elevado: boolean }
  | { error: string };

/**
 * Registra una respuesta que la persona dio conversando. Solo se acepta si la cita está, tal cual,
 * en lo que la persona acaba de decir: la respuesta no la decide el modelo, la dice ella.
 */
export async function registrarRespuesta(c: ContextoRespuesta, e: { instrumento: string; item: number; respuesta: string; cita: string }): Promise<ResultadoRespuesta> {
  const inst = INSTRUMENTOS[e.instrumento as ClaveInstrumento];
  if (!inst) return { error: 'Ese instrumento no existe.' };
  if (!inst.respuestas.includes(e.respuesta as Respuesta)) return { error: `Respuesta no válida. Opciones: ${inst.respuestas.join(', ')}.` };
  const cita = comparable(e.cita);
  if (cita.length < 2 || !comparable(c.textoPersona).includes(cita)) return { error: 'La cita debe ser una frase que la persona acaba de decir, tal cual. Si su respuesta no fue clara, pregúntale de nuevo con calma.' };

  const final = await transaccion(c.bd, async (t) => {
    const r = await t.query<{ id: string; respuestas_cifradas: Buffer }>(
      `SELECT id, respuestas_cifradas FROM tamizaje WHERE persona_id = $1 AND instrumento = $2 AND estado = 'en_curso' FOR UPDATE`,
      [c.personaId, inst.clave],
    );
    const fila = r.rows[0];
    if (!fila) return { error: 'No hay un tamizaje de ese tipo en curso.' } as const;
    if (!inst.items.some((i) => i.numero === e.item)) return { error: 'Ese número de pregunta no existe.' } as const;
    const respuestas = c.cifrador.descifrarJson<Respuestas>(fila.respuestas_cifradas);
    respuestas[e.item] = { respuesta: e.respuesta as Respuesta, cita: e.cita.slice(0, 240), turnoId: c.turnoPersonaId, sesionId: c.sesionId, en: c.ahora.toISOString() };
    const soloRespuestas = Object.fromEntries(Object.entries(respuestas).map(([k, v]) => [k, v.respuesta])) as Record<number, Respuesta>;
    const p = puntuar(inst, soloRespuestas);
    if (!p.completo) {
      await t.query('UPDATE tamizaje SET respuestas_cifradas = $2 WHERE id = $1', [fila.id, c.cifrador.cifrarJson(respuestas)]);
      const pendientes = inst.items.filter((i) => !respuestas[i.numero]);
      return { registrada: true, quedan: pendientes.length, siguiente: pendientes[0] ? `${pendientes[0].numero}. ${pendientes[0].pregunta}` : null, completado: false } as const;
    }
    // Completo: el puntaje lo calcula el código.
    const res = await t.query<{ id: string }>(
      `INSERT INTO resultado_tamizaje (persona_id, instrumento, puntaje, items_cifrado, aplicado_en, aplicado_por) VALUES ($1, $2, $3, $4, $5, 'agente_conversacional') RETURNING id`,
      [c.personaId, inst.clave, p.puntaje, c.cifrador.cifrarJson(respuestas), c.ahora],
    );
    await t.query(`UPDATE tamizaje SET estado = 'completado', terminado_en = $2, respuestas_cifradas = $3, resultado_id = $4 WHERE id = $1`, [fila.id, c.ahora, c.cifrador.cifrarJson(respuestas), res.rows[0]!.id]);
    await t.query('INSERT INTO senal (persona_id, tipo, valor, origen_turno_id, medido_en) VALUES ($1, $2, $3, $4, $5)', [c.personaId, `tamizaje.${inst.clave}`, p.puntaje, c.turnoPersonaId, c.ahora]);
    let eventoId: string | null = null;
    if (p.elevado && inst.nivelSiElevado >= 2) {
      // Especificación, nivel 2: "GDS elevado". Va a la bandeja de alertas y a la cadena de avisos.
      const ev = await t.query<{ id: string }>(
        `INSERT INTO evento_riesgo (persona_id, sesion_id, evidencia_turno_ids, nivel, nivel_reglas, fuente, categorias, detalle, fragmento_cifrado, accion, acuse_requerido)
         VALUES ($1, $2, $3, $4, 0, 'sistema', $5, $6, $7, 'tamizaje;escalamiento;bandeja_alertas', true) RETURNING id`,
        [
          c.personaId,
          c.sesionId,
          [...new Set(Object.values(respuestas).map((x) => x.turnoId))],
          inst.nivelSiElevado,
          [`tamizaje_${inst.clave}_elevado`],
          { instrumento: inst.clave, puntaje: p.puntaje, corte: inst.corte, maximo: inst.maximo },
          c.cifrador.cifrar(`${inst.nombre}: ${p.puntaje} de ${inst.maximo} (corte ${inst.corte}), aplicado conversando.`),
        ],
      );
      eventoId = ev.rows[0]!.id;
    }
    return { registrada: true, completado: true, elevado: p.elevado, eventoId, puntaje: p.puntaje } as const;
  });

  if ('error' in final) return { error: final.error };
  if (final.completado) {
    if (final.eventoId) {
      await iniciarEscalamiento(c.bd, { personaId: c.personaId, tipoEvento: 'riesgo', nivel: inst.nivelSiElevado as 2, categorias: [`tamizaje_${inst.clave}_elevado`], eventoRiesgoId: final.eventoId, ahora: c.ahora });
    }
    return { registrada: true, completado: true, elevado: final.elevado };
  }
  return final;
}

export async function resultadosTamizaje(bd: Consultable, personaId: string) {
  const r = await bd.query<{ id: string; instrumento: ClaveInstrumento; puntaje: string | null; aplicado_en: Date; aplicado_por: string }>(
    'SELECT id, instrumento, puntaje, aplicado_en, aplicado_por FROM resultado_tamizaje WHERE persona_id = $1 ORDER BY aplicado_en DESC LIMIT 50',
    [personaId],
  );
  return r.rows.map((f) => {
    const inst = INSTRUMENTOS[f.instrumento];
    const puntaje = f.puntaje === null ? null : Number(f.puntaje);
    return { id: f.id, instrumento: f.instrumento, nombre: inst?.nombre ?? f.instrumento, puntaje, maximo: inst?.maximo ?? null, corte: inst?.corte ?? null, elevado: inst && puntaje !== null ? puntaje >= inst.corte : null, aplicadoEn: f.aplicado_en, aplicadoPor: f.aplicado_por };
  });
}

/**
 * Lo que el compañero sabe del tamizaje en curso, para sus instrucciones. Nunca incluye puntajes.
 * TODO(clinico): revisar la forma de proponerlo y el ritmo (una pregunta por respuesta).
 */
export function instruccionesTamizaje(enCurso: readonly TamizajeEnCurso[]): string {
  const activos = enCurso.filter((t) => t.pendientes.length);
  if (!activos.length) return '';
  const lineas = activos.map((t) => {
    const respondidas = t.instrumento.items.length - t.pendientes.length;
    return `- ${t.instrumento.clave} (${t.instrumento.nombre}). Respuestas posibles: ${t.instrumento.respuestas.join(', ')}. Van ${respondidas} de ${t.instrumento.items.length}. Siguiente: ${t.pendientes[0]!.numero}. ${t.pendientes[0]!.pregunta}`;
  });
  return `TAMIZAJE EN CURSO (lo indicó su equipo de salud):
${lineas.join('\n')}
Cómo hacerlo:
- Si aún no lo has propuesto en esta conversación y no ha respondido ninguna, pide permiso con naturalidad ("¿le puedo hacer unas preguntas cortas sobre cómo se ha sentido esta semana?"). Si no quiere, no insistas.
- Como máximo una pregunta por respuesta tuya, cuando el clima de la conversación lo permita. Nunca en un momento de angustia o de riesgo.
- Formula la pregunta con tus palabras, pero sin cambiar su sentido; se refiere a la última semana.
- Cuando la persona responda con claridad, regístralo con tamizaje_registrar, con sus palabras textuales en "cita". Si la respuesta no es clara, pregunta de nuevo con calma o déjalo para otro momento.
- Nunca comentes puntajes, resultados ni lo que podría significar una respuesta. Agradece con sencillez y sigue conversando.`;
}
