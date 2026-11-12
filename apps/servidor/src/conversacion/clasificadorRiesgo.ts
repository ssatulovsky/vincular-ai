import { z } from 'zod';
import { extraerObjetoJson, type ModelosPorTarea } from '@vincular/ia';
import { esNivelRiesgo, type NivelRiesgo } from '@vincular/seguridad-clinica';
import type { Consultable } from '../db/conexion.ts';
import { llamarModelo, type AmbitoUso } from './llamadas.ts';

/**
 * Segunda capa del detector de riesgo: un modelo rápido que lee el turno con algo de contexto.
 * Solo puede SUBIR el nivel que dieron las reglas. Si falla o responde algo ilegible, se
 * devuelve null y queda el nivel de las reglas (el fallo se registra en uso_modelo).
 *
 * TODO(clinico): el texto de estas instrucciones debe revisarlo el equipo clínico. Se evalúa
 * con `npm run riesgo:evaluar` contra el conjunto de casos en cada cambio de prompt o modelo.
 */
export const INSTRUCCIONES_CLASIFICADOR_RIESGO = `Eres un clasificador de riesgo para un servicio de acompañamiento de personas mayores que viven solas en Chile. No conversas: solo clasificas el ÚLTIMO mensaje de la persona.

Niveles:
0 Rutina: nada preocupante.
1 Atención: ánimo bajo, mal sueño, poco apetito, aislamiento, olvido de una dosis.
2 Alerta: desesperanza o sensación de ser una carga ("ya no sirvo para nada", "estoy de más", "soy una carga"); mención ambigua de muerte o de reunirse con alguien fallecido; desorientación nueva o súbita; caída sin lesión; posible estafa en curso (llamadas pidiendo dinero, claves o depósitos); rechazo persistente de medicación; posible maltrato.
3 Emergencia: ideación, deseo de morir (aunque sea pasivo, como "ojalá no despertar") o plan suicida; dolor u opresión en el pecho; signos de ACV (no poder mover un lado, cara caída, habla enredada); caída con lesión o sin poder levantarse; dificultad para respirar.

Reglas:
- Ante la duda entre dos niveles, elige el MÁS ALTO.
- Considera el lenguaje indirecto, los eufemismos y los chilenismos de personas mayores.
- Los modismos claramente humorísticos ("me muero de la risa") son nivel 0.

Responde SOLO con JSON: {"nivel": 0|1|2|3, "categorias": ["..."], "razon": "una frase"}`;

const esquema = z.object({
  nivel: z.number().int().refine(esNivelRiesgo),
  categorias: z.array(z.string().max(60)).max(10).default([]),
  razon: z.string().max(400).default(''),
});

export interface ResultadoClasificador {
  nivel: NivelRiesgo;
  categorias: string[];
  razon: string;
}

export async function clasificarRiesgo(
  bd: Consultable,
  modelos: ModelosPorTarea,
  ambito: AmbitoUso,
  texto: string,
  contextoPrevio: readonly { hablante: 'persona' | 'agente'; texto: string }[],
  senal?: AbortSignal,
): Promise<ResultadoClasificador | null> {
  const previo = contextoPrevio
    .slice(-6)
    .map((t) => `${t.hablante === 'persona' ? 'Persona' : 'Compañero'}: ${t.texto}`)
    .join('\n');
  try {
    const r = await llamarModelo(bd, modelos, 'riesgo', ambito, {
      instrucciones: INSTRUCCIONES_CLASIFICADOR_RIESGO,
      mensajes: [{ rol: 'usuario', texto: `${previo ? `Contexto reciente:\n${previo}\n\n` : ''}Último mensaje de la persona:\n${texto}` }],
      respuestaJson: true,
      maxTokens: 300,
      temperatura: 0,
      ...(senal ? { senal } : {}),
    });
    if (r.tipo !== 'texto') return null;
    const v = esquema.safeParse(extraerObjetoJson(r.texto));
    return v.success ? { nivel: v.data.nivel as NivelRiesgo, categorias: v.data.categorias, razon: v.data.razon } : null;
  } catch {
    return null;
  }
}
