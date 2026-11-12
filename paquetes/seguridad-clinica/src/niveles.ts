/**
 * Niveles del protocolo de seguridad (especificación, sección 6).
 *
 * 0 Rutina · 1 Atención · 2 Alerta · 3 Emergencia
 */
export type NivelRiesgo = 0 | 1 | 2 | 3;

export const NOMBRE_NIVEL: Record<NivelRiesgo, string> = {
  0: 'rutina',
  1: 'atencion',
  2: 'alerta',
  3: 'emergencia',
};

/** Ante la duda se sube: el nivel combinado es siempre el mayor. */
export function nivelMayor(...niveles: Array<NivelRiesgo | null | undefined>): NivelRiesgo {
  let max: NivelRiesgo = 0;
  for (const n of niveles) if (n != null && n > max) max = n;
  return max;
}

export function esNivelRiesgo(v: unknown): v is NivelRiesgo {
  return v === 0 || v === 1 || v === 2 || v === 3;
}
