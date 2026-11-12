import { cronometro, pedir, pedirJson } from '../http.ts';
import { ErrorVoz, type PeticionReconocimiento, type PeticionSintesis, type Reconocedor, type ResultadoReconocimiento, type ResultadoSintesis, type Sintetizador } from '../tipos.ts';

const URL_BASE = 'https://api.elevenlabs.io/v1';

/**
 * ElevenLabs. El motor es el model_id (eleven_flash_v2_5, eleven_v4_turbo,
 * eleven_v3_conversational, eleven_multilingual_v2…). La voz es un voice_id: las voces de la
 * biblioteca (incluidas las de acento chileno) deben agregarse primero a "Mis voces".
 */
export class SintetizadorElevenLabs implements Sintetizador {
  readonly proveedor = 'elevenlabs' as const;

  constructor(private readonly o: { apiKey: string; timeoutMs?: number; url?: string }) {}

  async sintetizar(p: PeticionSintesis): Promise<ResultadoSintesis> {
    const t = cronometro();
    // ElevenLabs acepta velocidades entre 0.7 y 1.2.
    const velocidad = Math.min(1.2, Math.max(0.7, p.velocidad ?? 1));
    const r = await pedir('elevenlabs', `${this.o.url ?? URL_BASE}/text-to-speech/${encodeURIComponent(p.voz.voz)}?output_format=mp3_44100_128`, {
      cabeceras: { 'content-type': 'application/json', 'xi-api-key': this.o.apiKey, accept: 'audio/mpeg' },
      timeoutMs: this.o.timeoutMs ?? 20_000,
      senal: p.senal,
      cuerpo: JSON.stringify({ text: p.texto, model_id: p.voz.motor, language_code: p.voz.idioma, voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: velocidad } }),
    });
    const audio = Buffer.from(await r.arrayBuffer());
    if (audio.length === 0) throw new ErrorVoz('elevenlabs', 'ElevenLabs no devolvió audio');
    return { audio, mime: 'audio/mpeg', caracteres: p.texto.length, latenciaMs: t() };
  }

  /** Voces de la biblioteca compartida, para buscar acentos chilenos. */
  async buscarVoces(filtros: { idioma?: string; acento?: string; genero?: string; pagina?: number }): Promise<Array<{ voiceId: string; nombre: string; acento: string | null; genero: string | null; edad: string | null; descripcion: string | null; publicOwnerId: string; muestra: string | null }>> {
    const q = new URLSearchParams({ page_size: '50', language: filtros.idioma ?? 'es', ...(filtros.acento ? { accent: filtros.acento } : {}), ...(filtros.genero ? { gender: filtros.genero } : {}), ...(filtros.pagina ? { page: String(filtros.pagina) } : {}) });
    const d = await pedirJson<{ voices?: Array<{ voice_id: string; name: string; accent?: string; gender?: string; age?: string; description?: string; public_owner_id: string; preview_url?: string }> }>(
      'elevenlabs',
      `${this.o.url ?? URL_BASE}/shared-voices?${q}`,
      { metodo: 'GET', cabeceras: { 'xi-api-key': this.o.apiKey }, timeoutMs: this.o.timeoutMs ?? 20_000 },
    );
    return (d.voices ?? []).map((v) => ({ voiceId: v.voice_id, nombre: v.name, acento: v.accent ?? null, genero: v.gender ?? null, edad: v.age ?? null, descripcion: v.description ?? null, publicOwnerId: v.public_owner_id, muestra: v.preview_url ?? null }));
  }
}

/** ElevenLabs Scribe (reconocimiento de un turno completo). */
export class ReconocedorElevenLabs implements Reconocedor {
  readonly proveedor = 'elevenlabs' as const;
  readonly modelo: string;

  constructor(private readonly o: { apiKey: string; modelo?: string; timeoutMs?: number; url?: string }) {
    this.modelo = o.modelo ?? 'scribe_v3';
  }

  async reconocer(p: PeticionReconocimiento): Promise<ResultadoReconocimiento> {
    const t = cronometro();
    const form = new FormData();
    form.append('model_id', this.modelo);
    form.append('language_code', p.idioma);
    form.append('tag_audio_events', 'false');
    form.append('file', new Blob([new Uint8Array(p.audio)], { type: p.mime.split(';')[0] ?? 'application/octet-stream' }), 'turno');
    const d = await pedirJson<{ text?: string; language_probability?: number; words?: Array<{ start?: number; end?: number; type?: string }> }>('elevenlabs', `${this.o.url ?? URL_BASE}/speech-to-text`, {
      cabeceras: { 'xi-api-key': this.o.apiKey },
      timeoutMs: this.o.timeoutMs ?? 30_000,
      senal: p.senal,
      cuerpo: form,
    });
    const fin = (d.words ?? []).reduce((m, w) => Math.max(m, w.end ?? 0), 0);
    return {
      texto: (d.text ?? '').replace(/\s+/g, ' ').trim(),
      // Scribe no informa confianza por transcripción; la probabilidad del idioma no lo es.
      confianza: null,
      latenciaMs: t(),
      segundosAudio: fin > 0 ? fin : null,
    };
  }
}
