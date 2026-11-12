/**
 * Contrato del adaptador de modelos. El resto del sistema solo conoce estos tipos: cambiar de
 * proveedor es cambiar la configuración, no el código del orquestador.
 */

export type Proveedor = 'gemini' | 'anthropic';

/** Tareas con modelo propio (especificación, sección 5). */
export type Tarea = 'conversacion' | 'guardian' | 'riesgo' | 'extraccion' | 'informes' | 'embeddings';

export interface EspecificacionHerramienta {
  nombre: string;
  descripcion: string;
  /** JSON Schema del objeto de entrada. */
  esquemaEntrada: Record<string, unknown>;
}

export interface LlamadaHerramienta {
  id: string;
  nombre: string;
  entrada: unknown;
  /**
   * Dato opaco del proveedor que debe devolverse tal cual en el turno siguiente
   * (p. ej. la `thoughtSignature` de Gemini en modelos con razonamiento).
   */
  firma?: string;
}

export type MensajeModelo =
  | { rol: 'usuario'; texto: string }
  | { rol: 'asistente'; texto?: string; llamadas?: LlamadaHerramienta[] }
  | { rol: 'herramienta'; llamadaId: string; nombre: string; resultado: unknown };

export interface UsoTokens {
  tokensEntrada: number;
  tokensSalida: number;
}

export type RespuestaModelo =
  | { tipo: 'texto'; texto: string; uso: UsoTokens }
  | { tipo: 'herramientas'; llamadas: LlamadaHerramienta[]; texto?: string; uso: UsoTokens };

export interface PeticionModelo {
  instrucciones: string;
  mensajes: MensajeModelo[];
  herramientas?: EspecificacionHerramienta[];
  /** Pide una respuesta JSON (clasificadores). El adaptador usa el modo nativo del proveedor si existe. */
  respuestaJson?: boolean;
  maxTokens?: number;
  temperatura?: number;
  senal?: AbortSignal;
}

export interface PeticionEmbeddings {
  textos: string[];
  /** Documento que se guarda o consulta que se busca: algunos proveedores optimizan cada caso. */
  uso: 'documento' | 'consulta';
  dimension: number;
  senal?: AbortSignal;
}

export interface RespuestaEmbeddings {
  vectores: number[][];
  uso: UsoTokens;
}

export interface ModeloIA {
  readonly proveedor: Proveedor;
  readonly modelo: string;
  responder(p: PeticionModelo): Promise<RespuestaModelo>;
  /** Vectores para la memoria episódica. Lanza ErrorProveedor si el proveedor no los ofrece. */
  incrustar(p: PeticionEmbeddings): Promise<RespuestaEmbeddings>;
}

export class ErrorProveedor extends Error {
  constructor(
    readonly proveedor: Proveedor,
    mensaje: string,
    readonly estado?: number,
    /** Detalle para los registros del servidor; puede contener texto del proveedor. Nunca la clave. */
    readonly interno?: string,
  ) {
    super(mensaje);
    this.name = 'ErrorProveedor';
  }
}
