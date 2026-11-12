import { nivelMayor, type NivelRiesgo } from '../niveles.ts';
import { normalizar } from '../normalizar.ts';
import { MODISMOS_NEUTROS, REGLAS_RIESGO, type CategoriaRiesgo, type ReglaRiesgo } from './reglas.ts';

/**
 * Umbral de alerta personalizado del plan terapéutico ("avisar si menciona reunirse con él").
 * Se suma a las reglas generales: nunca las reemplaza ni las baja.
 */
export interface UmbralPersonal {
  id: string;
  /** Frase o palabras que el supervisor quiere vigilar. Se compara normalizada. */
  frase: string;
  nivel: NivelRiesgo;
  nota?: string;
}

export interface HallazgoRiesgo {
  reglaId: string;
  categoria: CategoriaRiesgo;
  nivel: NivelRiesgo;
  tipo: 'explicito' | 'indirecto' | 'personal';
  /** Fragmento del texto normalizado que activó la regla. */
  fragmento: string;
  negado: boolean;
}

export interface ResultadoRiesgoReglas {
  nivel: NivelRiesgo;
  hallazgos: HallazgoRiesgo[];
}

const NEGACIONES = /\b(no|nunca|jamas|tampoco)\s*$/;

/** Reemplaza los modismos neutros por un marcador para que no activen reglas. */
export function neutralizarModismos(textoNormalizado: string): string {
  let t = textoNormalizado;
  for (const m of MODISMOS_NEUTROS) t = t.replace(m, ' _modismo_ ');
  return t.replace(/\s+/g, ' ').trim();
}

function coincidencias(regla: ReglaRiesgo, texto: string): RegExpMatchArray[] {
  const flags = regla.patron.flags.includes('g') ? regla.patron.flags : regla.patron.flags + 'g';
  return [...texto.matchAll(new RegExp(regla.patron.source, flags))];
}

/**
 * Detector de riesgo por reglas sobre UN turno de la persona.
 *
 * Es síncrono y no depende de la red: corre antes de generar la respuesta, de modo que el
 * orquestador ya sabe el nivel por reglas cuando arma las instrucciones del modelo. El
 * clasificador con modelo de lenguaje corre en paralelo y solo puede SUBIR el nivel.
 */
export function detectarRiesgoPorReglas(
  texto: string,
  opciones: { umbralesPersonales?: readonly UmbralPersonal[] } = {},
): ResultadoRiesgoReglas {
  const normal = normalizar(texto);
  const limpio = neutralizarModismos(normal);
  const hallazgos: HallazgoRiesgo[] = [];

  for (const regla of REGLAS_RIESGO) {
    for (const m of coincidencias(regla, limpio)) {
      const antes = limpio.slice(0, m.index ?? 0);
      const negado = regla.nivelSiNegado !== undefined && NEGACIONES.test(antes);
      hallazgos.push({
        reglaId: regla.id,
        categoria: regla.categoria,
        nivel: negado ? regla.nivelSiNegado! : regla.nivel,
        tipo: regla.tipo,
        fragmento: m[0],
        negado,
      });
    }
  }

  // Los umbrales personales se comparan contra el texto normalizado SIN neutralizar modismos:
  // el supervisor puede querer vigilar justamente una expresión coloquial.
  for (const u of opciones.umbralesPersonales ?? []) {
    const frase = normalizar(u.frase);
    if (frase.length === 0) continue;
    const i = ` ${normal} `.indexOf(` ${frase} `);
    if (i >= 0) {
      hallazgos.push({ reglaId: `personal.${u.id}`, categoria: 'umbral_personal', nivel: u.nivel, tipo: 'personal', fragmento: frase, negado: false });
    }
  }

  // Varias reglas pueden marcar el mismo fragmento; se conserva una por regla.
  const unicos = new Map<string, HallazgoRiesgo>();
  for (const h of hallazgos) {
    const previo = unicos.get(h.reglaId);
    if (!previo || h.nivel > previo.nivel) unicos.set(h.reglaId, h);
  }
  const lista = [...unicos.values()].sort((a, b) => b.nivel - a.nivel);
  return { nivel: nivelMayor(...lista.map((h) => h.nivel)), hallazgos: lista };
}
