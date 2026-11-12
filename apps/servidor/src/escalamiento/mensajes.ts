import type { ContactosEmergencia } from '@vincular/seguridad-clinica';

/**
 * Textos de los avisos (SMS y llamada). Van por canales no cifrados, así que NO incluyen
 * detalles clínicos ni de la conversación: solo quién, qué tan urgente y qué hacer.
 * En nivel 3 el sistema no llama al SAMU: pide a quien recibe el aviso que se comunique con la
 * persona y, si corresponde, que active el SAMU (decisión del 12-11-2026).
 *
 * TODO(clinico): redacción definitiva, sobre todo la del aviso de riesgo emocional.
 */

export type TipoAviso = 'emergencia_medica' | 'emergencia' | 'alerta' | 'dosis_sin_respuesta';

const MEDICAS = ['dolor_toracico', 'signos_acv', 'dificultad_respiratoria', 'caida_con_lesion'];

export function tipoDeAviso(tipoEvento: string, nivel: number, categorias: readonly string[]): TipoAviso {
  if (tipoEvento === 'dosis_sin_respuesta') return 'dosis_sin_respuesta';
  if (nivel >= 3) return categorias.some((c) => MEDICAS.includes(c)) ? 'emergencia_medica' : 'emergencia';
  return 'alerta';
}

/** "Luis Soto" → "Luis S."; "María José Soto Pérez" → "María S." */
export function nombreCorto(nombre: string): string {
  // Con 4 o más palabras se asume "nombres + dos apellidos"; con 2 o 3, la segunda palabra.
  const p = nombre.trim().split(/\s+/);
  const apellido = p.length >= 4 ? p[p.length - 2] : p[1];
  return apellido ? `${p[0]} ${apellido[0]!.toUpperCase()}.` : (p[0] ?? '');
}

export interface DatosAviso {
  tipo: TipoAviso;
  nombre: string;
  /** Para dosis: hora local "08:00". */
  hora?: string;
  /** La persona dejó de responder durante la emergencia. */
  personaSinResponder?: boolean;
  /** Si el destinatario es la guardia (instrucciones de actuación). */
  paraGuardia: boolean;
  emergencia: ContactosEmergencia;
  /** Si se puede responder con 1 (hay webhook configurado). */
  aceptaRespuesta: boolean;
}

export function textoSms(d: DatosAviso): string {
  const quien = nombreCorto(d.nombre);
  const responder = d.aceptaRespuesta ? ' Responda 1 si usted se hace cargo.' : '';
  const silencio = d.personaSinResponder ? ' Dejó de responder en la tablet.' : '';
  switch (d.tipo) {
    case 'emergencia_medica':
      return `Vincular-IA EMERGENCIA: ${quien} podría necesitar ayuda médica urgente.${silencio} Llámela ahora; si no contesta o lo necesita, llame al SAMU ${d.emergencia.samu}.${responder}`;
    case 'emergencia':
      return `Vincular-IA EMERGENCIA: ${quien} necesita contacto humano urgente.${silencio} Llámela ahora y no la deje sola. Si hay peligro inmediato, llame al SAMU ${d.emergencia.samu}.${d.paraGuardia ? ` Línea de apoyo: ${d.emergencia.prevencionSuicidio}.` : ''}${responder}`;
    case 'alerta':
      return `Vincular-IA: ${quien} presenta una señal que conviene atender hoy. Comuníquese con ella${d.paraGuardia ? ' o revise el panel' : ''}.${responder}`;
    case 'dosis_sin_respuesta':
      return `Vincular-IA: ${quien} no ha confirmado sus remedios${d.hora ? ` de las ${d.hora}` : ''}. ¿Puede llamarla?${responder}`;
  }
}

/** Texto de la llamada: más corto y con los números dichos dígito por dígito. */
export function textoLlamada(d: DatosAviso, digitos: (n: string) => string): string {
  const quien = d.nombre.trim().split(/\s+/)[0] ?? '';
  const silencio = d.personaSinResponder ? ' Dejó de responder en la tablet.' : '';
  switch (d.tipo) {
    case 'emergencia_medica':
      return `Este es un aviso de emergencia de Vincular I A. ${quien} podría necesitar ayuda médica urgente.${silencio} Llámela ahora. Si no contesta o lo necesita, llame al SAMU, ${digitos(d.emergencia.samu)}.`;
    case 'emergencia':
      return `Este es un aviso de emergencia de Vincular I A. ${quien} necesita contacto humano urgente.${silencio} Llámela ahora y no la deje sola. Si hay peligro inmediato, llame al SAMU, ${digitos(d.emergencia.samu)}.`;
    case 'alerta':
      return `Este es un aviso de Vincular I A. ${quien} presenta una señal que conviene atender hoy. Por favor, comuníquese con ella.`;
    case 'dosis_sin_respuesta':
      return `Este es un aviso de Vincular I A. ${quien} no ha confirmado sus remedios. Por favor, llámela.`;
  }
}
