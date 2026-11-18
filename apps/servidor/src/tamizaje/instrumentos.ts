/**
 * Instrumentos de tamizaje conversacional (especificación, «Detección temprana» y «Medición de
 * impacto»). El puntaje lo calcula el código; el compañero nunca lo menciona ni lo interpreta.
 *
 * TODO(clinico): los textos son una traducción estándar al español. Reemplazar por las versiones
 * validadas en Chile (GDS-15: Hoyl et al., 2000) y confirmar los puntos de corte con el equipo
 * clínico. Mientras tanto se usa el corte más bajo habitual (falsos negativos no se aceptan).
 */

export type Respuesta = 'si' | 'no' | 'casi_nunca' | 'a_veces' | 'a_menudo';

export interface Item {
  numero: number;
  pregunta: string;
  /** Puntaje de cada respuesta posible. */
  puntaje: Partial<Record<Respuesta, number>>;
}

export interface Instrumento {
  clave: 'gds15' | 'ucla3';
  nombre: string;
  respuestas: Respuesta[];
  items: Item[];
  maximo: number;
  /** Desde este puntaje el resultado es "elevado". */
  corte: number;
  /** Nivel de riesgo de un resultado elevado (especificación, nivel 2: "GDS elevado"). */
  nivelSiElevado: 0 | 1 | 2;
  descripcion: string;
}

const siPuntua = { si: 1, no: 0 };
const noPuntua = { si: 0, no: 1 };

export const GDS15: Instrumento = {
  clave: 'gds15',
  nombre: 'Escala de depresión geriátrica (GDS-15)',
  respuestas: ['si', 'no'],
  maximo: 15,
  corte: 5,
  nivelSiElevado: 2,
  descripcion: 'Síntomas depresivos en personas mayores, 15 preguntas de sí o no, referidas a la última semana.',
  items: [
    { numero: 1, pregunta: '¿Está básicamente satisfecho/a con su vida?', puntaje: noPuntua },
    { numero: 2, pregunta: '¿Ha dejado de lado muchas de sus actividades e intereses?', puntaje: siPuntua },
    { numero: 3, pregunta: '¿Siente que su vida está vacía?', puntaje: siPuntua },
    { numero: 4, pregunta: '¿Se aburre a menudo?', puntaje: siPuntua },
    { numero: 5, pregunta: '¿Está de buen ánimo la mayor parte del tiempo?', puntaje: noPuntua },
    { numero: 6, pregunta: '¿Tiene miedo de que algo malo le vaya a pasar?', puntaje: siPuntua },
    { numero: 7, pregunta: '¿Se siente feliz la mayor parte del tiempo?', puntaje: noPuntua },
    { numero: 8, pregunta: '¿Se siente a menudo desamparado/a?', puntaje: siPuntua },
    { numero: 9, pregunta: '¿Prefiere quedarse en casa en vez de salir a hacer cosas nuevas?', puntaje: siPuntua },
    { numero: 10, pregunta: '¿Siente que tiene más problemas de memoria que la mayoría de la gente?', puntaje: siPuntua },
    { numero: 11, pregunta: '¿Piensa que es maravilloso estar vivo/a?', puntaje: noPuntua },
    { numero: 12, pregunta: '¿Se siente bastante inútil tal como está ahora?', puntaje: siPuntua },
    { numero: 13, pregunta: '¿Se siente lleno/a de energía?', puntaje: noPuntua },
    { numero: 14, pregunta: '¿Siente que su situación no tiene esperanza?', puntaje: siPuntua },
    { numero: 15, pregunta: '¿Cree que la mayoría de la gente está mejor que usted?', puntaje: siPuntua },
  ],
};

const frecuencia = { casi_nunca: 1, a_veces: 2, a_menudo: 3 };

export const UCLA3: Instrumento = {
  clave: 'ucla3',
  nombre: 'Escala de soledad UCLA, versión breve (3 ítems)',
  respuestas: ['casi_nunca', 'a_veces', 'a_menudo'],
  maximo: 9,
  corte: 6,
  // Soledad elevada: nivel 1 (atención), que alimenta las señales y el informe semanal.
  nivelSiElevado: 1,
  descripcion: 'Soledad percibida, 3 preguntas de frecuencia (casi nunca, a veces, a menudo).',
  items: [
    { numero: 1, pregunta: '¿Con qué frecuencia siente que le falta compañía?', puntaje: frecuencia },
    { numero: 2, pregunta: '¿Con qué frecuencia se siente dejado/a de lado?', puntaje: frecuencia },
    { numero: 3, pregunta: '¿Con qué frecuencia se siente aislado/a de los demás?', puntaje: frecuencia },
  ],
};

export const INSTRUMENTOS = { gds15: GDS15, ucla3: UCLA3 } as const;
export type ClaveInstrumento = keyof typeof INSTRUMENTOS;

export function puntuar(inst: Instrumento, respuestas: Record<number, Respuesta>): { puntaje: number; elevado: boolean; completo: boolean } {
  let puntaje = 0;
  let respondidos = 0;
  for (const item of inst.items) {
    const r = respuestas[item.numero];
    if (r === undefined) continue;
    const p = item.puntaje[r];
    if (p === undefined) continue;
    puntaje += p;
    respondidos++;
  }
  return { puntaje, elevado: puntaje >= inst.corte, completo: respondidos === inst.items.length };
}
