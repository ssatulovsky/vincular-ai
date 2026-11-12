import { detectarRiesgoPorReglas, type NivelRiesgo } from '@vincular/seguridad-clinica';
import { tasaErrorPalabras } from '@vincular/voz';

/**
 * Métricas del benchmark de reconocimiento de voz. Además de la tasa de error por palabra,
 * mide lo que importa para la seguridad: si una frase de riesgo sigue detectándose DESPUÉS de
 * pasar por el reconocimiento ("me duele el pecho" → "me duele el techo" es un riesgo perdido).
 */
export interface Evaluacion {
  wer: number;
  nivelReferencia: NivelRiesgo;
  nivelReconocido: NivelRiesgo;
  riesgoPerdido: boolean;
}

export function evaluarTranscripcion(referencia: string, reconocido: string): Evaluacion {
  const nivelReferencia = detectarRiesgoPorReglas(referencia).nivel;
  const nivelReconocido = detectarRiesgoPorReglas(reconocido).nivel;
  return { wer: tasaErrorPalabras(referencia, reconocido), nivelReferencia, nivelReconocido, riesgoPerdido: nivelReconocido < nivelReferencia };
}

export interface FilaBenchmark extends Evaluacion {
  proveedor: string;
  archivo: string;
  condicion: string;
  latenciaMs: number | null;
  error: string | null;
  reconocido: string;
}

export function percentil(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null;
  const o = [...xs].sort((a, b) => a - b);
  return o[Math.min(o.length - 1, Math.ceil((p / 100) * o.length) - 1)]!;
}

export interface ResumenProveedor {
  proveedor: string;
  audios: number;
  fallas: number;
  werPromedio: number | null;
  latenciaP50: number | null;
  latenciaP90: number | null;
  frasesDeRiesgo: number;
  riesgosPerdidos: number;
}

export function resumirBenchmark(filas: readonly FilaBenchmark[]): ResumenProveedor[] {
  return [...new Set(filas.map((f) => f.proveedor))].map((proveedor) => {
    const d = filas.filter((f) => f.proveedor === proveedor);
    const ok = d.filter((f) => !f.error);
    const lat = ok.map((f) => f.latenciaMs).filter((x): x is number => x !== null);
    const riesgo = d.filter((f) => f.nivelReferencia >= 1);
    return {
      proveedor,
      audios: d.length,
      fallas: d.length - ok.length,
      werPromedio: ok.length ? Math.round((ok.reduce((s, f) => s + f.wer, 0) / ok.length) * 1000) / 1000 : null,
      latenciaP50: percentil(lat, 50),
      latenciaP90: percentil(lat, 90),
      frasesDeRiesgo: riesgo.length,
      // Una falla del reconocedor en una frase de riesgo también es un riesgo perdido.
      riesgosPerdidos: riesgo.filter((f) => f.error || f.riesgoPerdido).length,
    };
  });
}
