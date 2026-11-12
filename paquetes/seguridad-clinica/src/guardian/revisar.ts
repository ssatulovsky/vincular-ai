import { normalizar } from '../normalizar.ts';
import { REGLAS_GUARDIAN, type CategoriaGuardian } from './reglas.ts';

export interface ProblemaGuardian {
  reglaId: string;
  categoria: CategoriaGuardian;
  fragmento: string;
  indicacion: string;
}

export interface ResultadoGuardianReglas {
  aprobada: boolean;
  problemas: ProblemaGuardian[];
}

/**
 * Primera capa del guardián: reglas deterministas sobre la respuesta del agente.
 *
 * `terminosProhibidos` viene del plan terapéutico (campo `no_mencionar`): la hipótesis o el
 * diagnóstico que el supervisor registró y que el agente nunca debe decirle a la persona.
 */
export function revisarRespuestaPorReglas(
  respuesta: string,
  opciones: { terminosProhibidos?: readonly string[] } = {},
): ResultadoGuardianReglas {
  const texto = normalizar(respuesta);
  const problemas: ProblemaGuardian[] = [];

  if (texto.length === 0) {
    problemas.push({ reglaId: 'vacia', categoria: 'diagnostico', fragmento: '', indicacion: 'La respuesta no puede estar vacía.' });
  }

  for (const regla of REGLAS_GUARDIAN) {
    const m = regla.patron.exec(texto);
    if (m) problemas.push({ reglaId: regla.id, categoria: regla.categoria, fragmento: m[0], indicacion: regla.indicacion });
  }

  for (const termino of opciones.terminosProhibidos ?? []) {
    const t = normalizar(termino);
    if (t.length > 0 && ` ${texto} `.includes(` ${t} `)) {
      problemas.push({
        reglaId: 'plan.no_mencionar',
        categoria: 'termino_del_plan',
        fragmento: t,
        indicacion: 'Mencionaste un término que el equipo clínico pidió no usar con esta persona. Reformula sin él y sin aludir a diagnósticos ni hipótesis clínicas.',
      });
    }
  }
  return { aprobada: problemas.length === 0, problemas };
}

/** Texto para el reintento: qué falló, sin repetir lo que dijo el modelo. */
export function indicacionesDeRegeneracion(problemas: ReadonlyArray<Pick<ProblemaGuardian, 'indicacion'>>): string {
  const unicas = [...new Set(problemas.map((p) => p.indicacion))];
  return [
    'Tu respuesta anterior no se puede enviar porque no cumple estas reglas:',
    ...unicas.map((i) => `- ${i}`),
    'Escribe una respuesta nueva que las cumpla, con el mismo tono cálido y breve.',
  ].join('\n');
}
