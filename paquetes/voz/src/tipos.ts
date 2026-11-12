/**
 * Contrato del adaptador de voz. El servidor y las herramientas de benchmark solo conocen estos
 * tipos: cambiar de proveedor o de voz es configuración.
 */

export type ProveedorVoz = 'google' | 'elevenlabs';

/** Una voz concreta, tal como se elige en el onboarding o en la prueba ciega. */
export interface VozConfigurada {
  /** Identificador estable en Vincular-IA (p. ej. "g-chirp-kore"). */
  id: string;
  proveedor: ProveedorVoz;
  /**
   * Google: "chirp3hd" (Cloud TTS, voces HD, con streaming) o "gemini" (Gemini-TTS, con
   * instrucciones de estilo). ElevenLabs: el model_id (p. ej. "eleven_flash_v2_5").
   */
  motor: string;
  /** Google: nombre de la voz (p. ej. "es-US-Chirp3-HD-Kore" o "Kore"). ElevenLabs: voice_id. */
  voz: string;
  /** Código de idioma del proveedor (Google: "es-US", "es-419"; ElevenLabs: "es"). */
  idioma: string;
  /** Solo Gemini-TTS: instrucción de estilo ("habla cálida y pausada, acento chileno"). */
  estilo?: string;
  /** Nombre para mostrar a la persona y descripción para el equipo. */
  nombre: string;
  descripcion?: string;
  genero?: 'femenina' | 'masculina';
  grave?: boolean;
}

export interface PeticionSintesis {
  texto: string;
  voz: VozConfigurada;
  /** 1 = normal. Rango útil 0.7–1.2 (ElevenLabs limita a ese rango). */
  velocidad?: number;
  senal?: AbortSignal;
}

export interface ResultadoSintesis {
  audio: Buffer;
  /** Tipo MIME del audio entregado (siempre MP3 en este sprint, para reproducir en cualquier navegador). */
  mime: 'audio/mpeg';
  caracteres: number;
  latenciaMs: number;
}

export interface PeticionReconocimiento {
  audio: Buffer;
  /** Tipo MIME del audio (p. ej. "audio/webm;codecs=opus", "audio/wav"). */
  mime: string;
  /** Idioma esperado (Google: "es-US"; ElevenLabs: "es"). */
  idioma: string;
  senal?: AbortSignal;
}

export interface ResultadoReconocimiento {
  texto: string;
  /** 0–1 cuando el proveedor la informa. */
  confianza: number | null;
  latenciaMs: number;
  /** Duración del audio en segundos, si el proveedor la informa (para el costo). */
  segundosAudio: number | null;
}

export interface Sintetizador {
  readonly proveedor: ProveedorVoz;
  sintetizar(p: PeticionSintesis): Promise<ResultadoSintesis>;
}

export interface Reconocedor {
  readonly proveedor: ProveedorVoz;
  readonly modelo: string;
  reconocer(p: PeticionReconocimiento): Promise<ResultadoReconocimiento>;
}

export class ErrorVoz extends Error {
  constructor(
    readonly proveedor: ProveedorVoz,
    mensaje: string,
    readonly estado?: number,
    /** Detalle para los registros; nunca contiene claves. */
    readonly interno?: string,
  ) {
    super(mensaje);
    this.name = 'ErrorVoz';
  }
}
