import { ModeloAnthropic } from './proveedores/anthropic.ts';
import { ModeloGemini } from './proveedores/gemini.ts';
import type { ModeloIA, Proveedor, Tarea } from './tipos.ts';

export interface ConfigModeloTarea {
  proveedor: Proveedor;
  modelo: string;
  timeoutMs: number;
}

export interface ConfigIA {
  claves: Partial<Record<Proveedor, string>>;
  urls?: Partial<Record<Proveedor, string>>;
  tareas: Record<Tarea, ConfigModeloTarea>;
}

export type ModeloConListado = ModeloIA & { listarModelos(): Promise<string[]> };

export function crearModelo(c: ConfigModeloTarea, clave: string, url?: string): ModeloConListado {
  const base = { apiKey: clave, modelo: c.modelo, timeoutMs: c.timeoutMs, ...(url ? { url } : {}) };
  switch (c.proveedor) {
    case 'gemini':
      return new ModeloGemini(base);
    case 'anthropic':
      return new ModeloAnthropic(base);
  }
}

/**
 * Un modelo por tarea: conversación con un modelo de alta calidad; guardián, riesgo y
 * extracción con uno rápido y económico. Cada tarea puede usar un proveedor distinto.
 */
export class ModelosPorTarea {
  private readonly cache = new Map<Tarea, ModeloConListado>();

  constructor(private readonly config: ConfigIA) {}

  para(tarea: Tarea): ModeloConListado {
    const previo = this.cache.get(tarea);
    if (previo) return previo;
    const c = this.config.tareas[tarea];
    const clave = this.config.claves[c.proveedor];
    if (!clave) throw new Error(`Falta la clave de API de ${c.proveedor} para la tarea "${tarea}".`);
    const m = crearModelo(c, clave, this.config.urls?.[c.proveedor]);
    this.cache.set(tarea, m);
    return m;
  }
}
