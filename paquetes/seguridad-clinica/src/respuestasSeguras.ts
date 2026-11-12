import type { NivelRiesgo } from './niveles.ts';

/**
 * Respuestas predefinidas que se usan cuando el guardián rechaza dos veces, cuando el
 * proveedor de IA no responde o cuando el detector marca una emergencia.
 *
 * TODO(clinico): TODOS estos textos son provisorios. Deben redactarlos o aprobarlos el equipo
 * clínico, probarse con personas mayores del co-diseño y escucharse en voz alta (Sprint 3).
 * Criterios técnicos aplicados mientras tanto: frases cortas, trato de "usted" por defecto,
 * sin diagnósticos, el agente dice lo que va a hacer antes de hacerlo y nunca cierra la
 * conversación en una emergencia.
 */

export interface ContactosEmergencia {
  /** p. ej. "131" (SAMU). Viene de configuración verificada, nunca del prompt. */
  samu: string;
  /** p. ej. "*4141" (línea de prevención del suicidio). */
  prevencionSuicidio: string;
}

export type Trato = 'usted' | 'tu';

/** Respuesta genérica cuando no se pudo producir una respuesta aprobada. */
export function respuestaSeguraGeneral(trato: Trato = 'usted'): string {
  return trato === 'tu'
    ? 'Perdona, se me enredaron las ideas. ¿Me lo cuentas de nuevo, con calma?'
    : 'Disculpe, se me enredaron las ideas. ¿Me lo cuenta de nuevo, con calma?';
}

/** Respuesta cuando el servicio de IA no está disponible y no hay riesgo detectado. */
export function respuestaSinServicio(trato: Trato = 'usted'): string {
  return trato === 'tu'
    ? 'Perdona, tengo un problema para pensar en este momento. Si necesitas ayuda con algo urgente, llama a alguien de confianza. Lo intento de nuevo en un ratito.'
    : 'Disculpe, tengo un problema para pensar en este momento. Si necesita ayuda con algo urgente, llame a alguien de confianza. Lo intento de nuevo en un ratito.';
}

/**
 * Nivel 3 por ideación o plan suicida. Se queda en la conversación, dice lo que hará y da una
 * instrucción simple. TODO(clinico): redacción definitiva y orden de las instrucciones.
 */
export function respuestaEmergenciaSuicidio(c: ContactosEmergencia, trato: Trato = 'usted'): string {
  return trato === 'tu'
    ? `Gracias por contármelo. Me importa mucho cómo estás y aquí sigo contigo. Voy a avisar ahora a tu persona de confianza y a tu equipo de apoyo para que se comuniquen contigo. Si sientes que puedes hacerte daño, llama ahora al ${c.prevencionSuicidio} o al ${c.samu}. Yo sigo aquí contigo. ¿Estás en un lugar seguro en este momento?`
    : `Gracias por contármelo. Me importa mucho cómo está y aquí sigo con usted. Voy a avisar ahora a su persona de confianza y a su equipo de apoyo para que se comuniquen con usted. Si siente que puede hacerse daño, llame ahora al ${c.prevencionSuicidio} o al ${c.samu}. Yo sigo aquí con usted. ¿Está en un lugar seguro en este momento?`;
}

/** Nivel 3 por emergencia médica (dolor torácico, signos de ACV, caída con lesión, ahogo). */
export function respuestaEmergenciaMedica(c: ContactosEmergencia, trato: Trato = 'usted'): string {
  return trato === 'tu'
    ? `Esto es importante. Llama ahora al ${c.samu}, el SAMU. Voy a avisar a tu persona de confianza y a tu equipo de apoyo. Si puedes, siéntate o acuéstate y deja la puerta sin llave. Yo sigo aquí contigo.`
    : `Esto es importante. Llame ahora al ${c.samu}, el SAMU. Voy a avisar a su persona de confianza y a su equipo de apoyo. Si puede, siéntese o acuéstese y deje la puerta sin llave. Yo sigo aquí con usted.`;
}

/**
 * Elige la respuesta segura según el nivel y la categoría. Para nivel 3 nunca devuelve la
 * respuesta genérica.
 */
export function respuestaSeguraPara(
  nivel: NivelRiesgo,
  categorias: readonly string[],
  c: ContactosEmergencia,
  trato: Trato = 'usted',
): string {
  if (nivel === 3) {
    const medica = categorias.some((x) => ['dolor_toracico', 'signos_acv', 'dificultad_respiratoria', 'caida_con_lesion'].includes(x));
    // Si hay de ambos tipos, primero la emergencia médica: es la más inmediata.
    if (medica) return respuestaEmergenciaMedica(c, trato);
    // Sin categoría médica (incluida la ideación y los umbrales personales) se usa la de crisis.
    return respuestaEmergenciaSuicidio(c, trato);
  }
  if (nivel === 2) {
    return trato === 'tu'
      ? 'Gracias por contármelo. Esto me parece importante, así que voy a avisar a tu persona de confianza y a tu equipo de apoyo. Si quieres, la llamamos juntos ahora. ¿Te parece?'
      : 'Gracias por contármelo. Esto me parece importante, así que voy a avisar a su persona de confianza y a su equipo de apoyo. Si quiere, la llamamos juntos ahora. ¿Le parece?';
  }
  return respuestaSeguraGeneral(trato);
}

/**
 * Línea que el CÓDIGO agrega al final de cada respuesta mientras dura el modo emergencia, para
 * que los números estén siempre presentes sin depender del modelo ni ponerlos en el prompt.
 */
export function recordatorioEmergencia(categorias: readonly string[], c: ContactosEmergencia, trato: Trato = 'usted'): string {
  const medica = categorias.some((x) => ['dolor_toracico', 'signos_acv', 'dificultad_respiratoria', 'caida_con_lesion'].includes(x));
  if (medica) return trato === 'tu' ? `Si te sientes peor, llama al ${c.samu}.` : `Si se siente peor, llame al ${c.samu}.`;
  return trato === 'tu'
    ? `Recuerda que puedes llamar ahora al ${c.prevencionSuicidio} o al ${c.samu}.`
    : `Recuerde que puede llamar ahora al ${c.prevencionSuicidio} o al ${c.samu}.`;
}
