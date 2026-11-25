import { z } from 'zod';
import type { Consultable } from '../db/conexion.ts';

/**
 * Requisitos para conversar con el compañero (decisión 0018).
 *
 *  1. Consentimiento informado vigente (Ley 21.719: los datos de salud y emocionales son datos
 *     sensibles y requieren consentimiento explícito; la especificación pide revisarlo cada 6 meses).
 *  2. Evaluación clínica de ingreso vigente con resultado apto o apto con resguardos, registrada
 *     por un profesional clínico asignado (criterios de exclusión revisados).
 *  3. La persona no está pausada ni dada de baja.
 *
 * Excepción de seguridad: si hay una emergencia en curso sin acuse humano, el compañero nunca se
 * bloquea (ver `abrirSesionConEmergencia`). Lo decide quien llama, con `hayEmergencia`.
 */

export type Requisito = 'consentimiento' | 'evaluacion' | 'estado';

/**
 * Criterios de exclusión que el profesional revisa en la evaluación de ingreso.
 * TODO(clinico): lista definitiva y su redacción, validadas por el equipo de salud mental. Mientras
 * tanto, valores conservadores: cualquiera marcado obliga a "no apto" o "apto con resguardos".
 */
export const CRITERIOS_EXCLUSION = {
  psicosis_activa: 'Síntomas psicóticos activos (alucinaciones, ideas delirantes)',
  mania_hipomania: 'Episodio maníaco o hipomaníaco actual',
  riesgo_suicida_alto: 'Riesgo suicida alto no estabilizado o intento reciente',
  demencia_moderada_severa: 'Deterioro cognitivo moderado o severo que impide comprender qué es el compañero',
  delirium: 'Cuadro confusional agudo (posible delirium)',
  consumo_problematico: 'Consumo problemático de alcohol o drogas sin tratamiento',
  sin_red_de_apoyo: 'Sin ningún contacto de apoyo para avisar en una emergencia',
} as const;

export type CriterioExclusion = keyof typeof CRITERIOS_EXCLUSION;

export const esquemaEvaluacion = z
  .object({
    resultado: z.enum(['apto', 'apto_con_resguardos', 'no_apto']),
    // Todos los criterios deben venir revisados (true = presente).
    criterios: z.object(Object.fromEntries(Object.keys(CRITERIOS_EXCLUSION).map((k) => [k, z.boolean()])) as Record<CriterioExclusion, z.ZodBoolean>).strict(),
    notas: z.string().trim().max(2000).default(''),
    // TODO(clinico): plazo de revisión. Conservador: 6 meses, como el consentimiento.
    revisarAntesDe: z.string().date().nullable().default(null),
  })
  .superRefine((e, ctx) => {
    const presentes = Object.entries(e.criterios).filter(([, v]) => v).map(([k]) => k);
    // Con un criterio de exclusión presente no puede quedar "apto" sin más: o resguardos explícitos, o no apto.
    if (presentes.length > 0 && e.resultado === 'apto') {
      ctx.addIssue({ code: 'custom', path: ['resultado'], message: 'Hay criterios de exclusión marcados: elija "apto con resguardos" (con indicaciones) o "no apto"' });
    }
    if (e.resultado === 'apto_con_resguardos' && e.notas.length < 10) {
      ctx.addIssue({ code: 'custom', path: ['notas'], message: 'Describa los resguardos o indicaciones para el equipo' });
    }
  });

export type DatosEvaluacion = z.infer<typeof esquemaEvaluacion>;

/** Requisitos que faltan hoy (fecha de Chile). Lista vacía = puede conversar. */
export async function requisitosPendientes(bd: Consultable, personaId: string): Promise<Requisito[]> {
  const r = await bd.query<{ estado: string; consentimiento_ok: boolean; evaluacion_ok: boolean }>(
    `WITH hoy AS (SELECT (now() AT TIME ZONE 'America/Santiago')::date AS d)
     SELECT p.estado,
            coalesce(p.consentimiento_vigente_hasta >= hoy.d, false)
              AND EXISTS (SELECT 1 FROM consentimiento k WHERE k.persona_id = p.id AND k.revocado_en IS NULL) AS consentimiento_ok,
            coalesce((SELECT e.resultado <> 'no_apto' AND e.revisar_antes_de >= hoy.d
                        FROM evaluacion_ingreso e WHERE e.persona_id = p.id ORDER BY e.creado_en DESC LIMIT 1), false) AS evaluacion_ok
       FROM persona p, hoy WHERE p.id = $1`,
    [personaId],
  );
  const f = r.rows[0];
  if (!f) return ['estado'];
  const faltan: Requisito[] = [];
  if (f.estado === 'pausada' || f.estado === 'baja') faltan.push('estado');
  if (!f.consentimiento_ok) faltan.push('consentimiento');
  if (!f.evaluacion_ok) faltan.push('evaluacion');
  return faltan;
}

/** Texto para la persona: tranquilo, sin culpas, con a quién llamar si es urgente. */
export function mensajeRequisitos(faltan: Requisito[], emergencia: { samu: string; prevencionSuicidio: string }): string {
  const base = faltan.includes('estado')
    ? 'Su compañero está en pausa por ahora. Su equipo de salud lo sabe y se pondrá en contacto.'
    : 'Su compañero estará disponible apenas su equipo de salud termine unos trámites. Ellos ya lo saben.';
  return `${base} Si necesita ayuda urgente, llame al ${emergencia.samu} (SAMU) o al ${emergencia.prevencionSuicidio}.`;
}
