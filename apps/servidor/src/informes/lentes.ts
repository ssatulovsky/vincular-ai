/**
 * Lentes teóricas para el análisis de las conversaciones (especificación «Vínculo», sección
 * «Lentes teóricas»). Activas por defecto (decisión 0011); el supervisor puede desactivar una por
 * caso desde el plan terapéutico. La transferencia hacia el agente se analiza siempre.
 *
 * Las lecturas son solo para el profesional: el agente nunca hace interpretaciones a la persona.
 *
 * TODO(clinico): validar cada lente comparando con lecturas independientes de dos o más analistas;
 * si la concordancia es baja, se desactiva o se reformula.
 */

export const LENTES = {
  pichon_adaptacion: {
    nombre: 'Pichon-Rivière: adaptación a la realidad',
    conceptos: 'Adaptación activa (se transforma y transforma su medio: proyectos, pide ayuda, cambia rutinas) frente a adaptación pasiva (sometimiento, estereotipia, queja repetida).',
  },
  pichon_vinculo_roles: {
    nombre: 'Pichon-Rivière: vínculo y roles',
    conceptos: 'Roles que asume en sus relatos (cuidadora, víctima, depositaria, portavoz de la familia); el tercero presente en el vínculo; el rol que asigna al agente.',
  },
  pichon_ansiedades: {
    nombre: 'Pichon-Rivière: ansiedades y cambio',
    conceptos: 'Miedo a la pérdida y miedo al ataque; resistencia al cambio; pretarea y tarea; emergentes.',
  },
  pichon_cono_invertido: {
    nombre: 'Pichon-Rivière: cono invertido (adaptado a la díada)',
    conceptos: 'Comunicación, aprendizaje, pertenencia, cooperación, pertinencia y telé en la relación con el agente y con su red.',
  },
  freud: {
    nombre: 'Freud',
    conceptos: 'Mecanismos de defensa (negación, proyección, desplazamiento, racionalización); duelo frente a melancolía (autorreproches, identificación con el objeto perdido); repetición.',
  },
  klein: {
    nombre: 'Klein',
    conceptos: 'Posición esquizo-paranoide y depresiva; escisión (idealización y denigración); reparación; duelo como reelaboración de la posición depresiva.',
  },
  lacan: {
    nombre: 'Lacan',
    conceptos: 'Significantes que insisten; enunciado y enunciación; la demanda dirigida al Otro (incluido el agente); el lugar que le da al otro en su discurso.',
  },
  winnicott: {
    nombre: 'Winnicott',
    conceptos: 'Sostén (holding); objeto transicional; verdadero y falso self.',
  },
  bowlby_erikson: {
    nombre: 'Bowlby y Erikson',
    conceptos: 'Estilo de apego y duelo; integridad frente a desesperación en la revisión de vida.',
  },
  transferencia: {
    nombre: 'Transferencia hacia el agente',
    conceptos: 'Qué deposita la persona en el compañero, qué lugar le asigna y qué figura de su historia parece encarnar.',
  },
} as const;

export type Lente = keyof typeof LENTES;
export const CLAVES_LENTES = Object.keys(LENTES) as Lente[];
/** La única que no se puede desactivar. */
export const LENTE_OBLIGATORIA: Lente = 'transferencia';
export const LENTES_DESACTIVABLES = CLAVES_LENTES.filter((l) => l !== LENTE_OBLIGATORIA) as Exclude<Lente, 'transferencia'>[];

export function lentesActivas(desactivadas: readonly string[] = []): Lente[] {
  return CLAVES_LENTES.filter((l) => l === LENTE_OBLIGATORIA || !desactivadas.includes(l));
}
