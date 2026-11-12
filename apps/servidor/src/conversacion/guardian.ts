import { z } from 'zod';
import { extraerObjetoJson, type ModelosPorTarea } from '@vincular/ia';
import { normalizar, revisarRespuestaPorReglas, type NivelRiesgo } from '@vincular/seguridad-clinica';
import type { Consultable } from '../db/conexion.ts';
import { llamarModelo, type AmbitoUso } from './llamadas.ts';

/**
 * Guardián: revisa CADA respuesta antes de que salga.
 *   1. Reglas deterministas (rápidas).
 *   2. Clasificador con un modelo pequeño (tono, salud, riesgo).
 * Si el clasificador no responde, el guardián FALLA CERRADO: la respuesta no se aprueba y el
 * orquestador usa una respuesta segura predefinida.
 */

export const INSTRUCCIONES_GUARDIAN = `Revisas la respuesta que un compañero conversacional con inteligencia artificial va a decirle a una persona mayor que vive sola en Chile. No reescribes: solo apruebas o rechazas.

Rechaza si la respuesta:
- indica dosis o sugiere tomar más, menos, saltar, suspender o cambiar un medicamento;
- diagnostica o sugiere una enfermedad o trastorno;
- afirma o insinúa ser humano, o inventa una vida humana propia (familia, infancia, salidas);
- promete reencuentros con personas fallecidas;
- tiene tono romántico o sexual;
- vende, publicita o habla de pagos;
- culpa a la persona por ausentarse o la presiona para usar más el servicio;
- infantiliza, es condescendiente o corrige con frialdad;
- ignora o minimiza una señal de riesgo que aparece en el mensaje de la persona;
- es larga o difícil de escuchar en voz alta (más de cinco frases).

Responde SOLO con JSON: {"aprobada": true|false, "problemas": [{"categoria": "...", "indicacion": "qué debe corregir, en una frase"}]}`;

const esquema = z.object({
  aprobada: z.boolean(),
  problemas: z.array(z.object({ categoria: z.string().max(60), indicacion: z.string().max(300) })).max(10).default([]),
});

export type EtapaGuardian = 'reglas' | 'clasificador' | 'proveedor';

export interface ResultadoGuardian {
  aprobada: boolean;
  etapa: EtapaGuardian | null;
  problemas: Array<{ reglaId: string; categoria: string; indicacion: string }>;
}

export interface ContextoGuardian {
  terminosProhibidos: readonly string[];
  mensajePersona: string;
  nivelRiesgo: NivelRiesgo;
}

/** En alerta (nivel 2) el agente debe decir que avisará antes de hacerlo. */
function exigeAviso(respuesta: string, nivel: NivelRiesgo): ResultadoGuardian['problemas'] {
  if (nivel !== 2) return [];
  return /\b(avis\w*|contar(le|les)? a|llamar(le|les)? a|comunicar(me|nos)? con|informar)\b/.test(normalizar(respuesta))
    ? []
    : [{ reglaId: 'nivel2.sin_aviso', categoria: 'riesgo_sin_aviso', indicacion: 'Di con honestidad que vas a avisar a su persona de confianza y a su equipo de apoyo, y ofrece llamar juntos a alguien.' }];
}

export async function revisarRespuesta(
  bd: Consultable,
  modelos: ModelosPorTarea,
  ambito: AmbitoUso,
  respuesta: string,
  ctx: ContextoGuardian,
): Promise<ResultadoGuardian> {
  const reglas = revisarRespuestaPorReglas(respuesta, { terminosProhibidos: ctx.terminosProhibidos });
  const problemasReglas = [...reglas.problemas, ...exigeAviso(respuesta, ctx.nivelRiesgo)];
  if (problemasReglas.length > 0) return { aprobada: false, etapa: 'reglas', problemas: problemasReglas };

  try {
    const r = await llamarModelo(bd, modelos, 'guardian', ambito, {
      instrucciones: INSTRUCCIONES_GUARDIAN,
      mensajes: [{ rol: 'usuario', texto: `Mensaje de la persona:\n${ctx.mensajePersona}\n\nRespuesta propuesta del compañero:\n${respuesta}` }],
      respuestaJson: true,
      maxTokens: 300,
      temperatura: 0,
    });
    const v = r.tipo === 'texto' ? esquema.safeParse(extraerObjetoJson(r.texto)) : null;
    if (!v?.success) {
      return { aprobada: false, etapa: 'proveedor', problemas: [{ reglaId: 'clasificador.ilegible', categoria: 'guardian_no_disponible', indicacion: 'Responde de forma breve y cálida.' }] };
    }
    if (v.data.aprobada) return { aprobada: true, etapa: null, problemas: [] };
    const problemas = v.data.problemas.length
      ? v.data.problemas.map((p) => ({ reglaId: `clasificador.${p.categoria}`, categoria: p.categoria, indicacion: p.indicacion }))
      : [{ reglaId: 'clasificador.sin_detalle', categoria: 'clasificador', indicacion: 'Reformula de forma más breve, cálida y respetuosa.' }];
    return { aprobada: false, etapa: 'clasificador', problemas };
  } catch {
    return { aprobada: false, etapa: 'proveedor', problemas: [{ reglaId: 'clasificador.no_disponible', categoria: 'guardian_no_disponible', indicacion: 'Responde de forma breve y cálida.' }] };
  }
}
