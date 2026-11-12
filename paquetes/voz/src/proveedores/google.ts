import { AutenticadorGoogle } from '../googleAuth.ts';
import { cronometro, pedirJson } from '../http.ts';
import { ErrorVoz, type PeticionReconocimiento, type PeticionSintesis, type Reconocedor, type ResultadoReconocimiento, type ResultadoSintesis, type Sintetizador } from '../tipos.ts';

const URL_TTS = 'https://texttospeech.googleapis.com/v1/text:synthesize';

/**
 * Google Cloud Text-to-Speech.
 *   - motor "chirp3hd": voces Chirp 3 HD ("es-US-Chirp3-HD-<Estrella>"). Español solo es-US y es-ES.
 *   - motor "gemini": Gemini-TTS. La voz es un nombre ("Kore") y el modelo va en `modeloGemini`.
 *     Acepta una instrucción de estilo en lenguaje natural (acento, calidez, ritmo).
 */
export class SintetizadorGoogle implements Sintetizador {
  readonly proveedor = 'google' as const;

  constructor(
    private readonly auth: AutenticadorGoogle,
    private readonly o: { modeloGemini?: string; timeoutMs?: number; url?: string } = {},
  ) {}

  async sintetizar(p: PeticionSintesis): Promise<ResultadoSintesis> {
    const t = cronometro();
    const gemini = p.voz.motor === 'gemini';
    if (gemini && !this.o.modeloGemini) throw new ErrorVoz('google', 'Falta el modelo de Gemini-TTS (VOZ_GOOGLE_MODELO_GEMINI)');
    const d = await pedirJson<{ audioContent?: string }>('google', this.o.url ?? URL_TTS, {
      cabeceras: { 'content-type': 'application/json', ...(await this.auth.cabeceras()) },
      timeoutMs: this.o.timeoutMs ?? 20_000,
      senal: p.senal,
      cuerpo: JSON.stringify({
        input: gemini ? { text: p.texto, ...(p.voz.estilo ? { prompt: p.voz.estilo } : {}) } : { text: p.texto },
        voice: { languageCode: p.voz.idioma, name: p.voz.voz, ...(gemini ? { modelName: this.o.modeloGemini } : {}) },
        audioConfig: { audioEncoding: 'MP3', speakingRate: p.velocidad ?? 1 },
      }),
    });
    if (!d.audioContent) throw new ErrorVoz('google', 'Google no devolvió audio');
    return { audio: Buffer.from(d.audioContent, 'base64'), mime: 'audio/mpeg', caracteres: p.texto.length, latenciaMs: t() };
  }
}

/**
 * Google Cloud Speech-to-Text v2 con el modelo Chirp 3 (reconocimiento síncrono de un turno,
 * hasta 60 s). Requiere cuenta de servicio. Español: es-US y es-ES (GA), es-MX (vista previa);
 * no hay es-CL.
 */
export class ReconocedorGoogle implements Reconocedor {
  readonly proveedor = 'google' as const;
  readonly modelo: string;

  constructor(
    private readonly auth: AutenticadorGoogle,
    private readonly o: { modelo?: string; region?: string; timeoutMs?: number; url?: string } = {},
  ) {
    this.modelo = o.modelo ?? 'chirp_3';
  }

  async reconocer(p: PeticionReconocimiento): Promise<ResultadoReconocimiento> {
    const proyecto = this.auth.proyecto;
    if (!proyecto) throw new ErrorVoz('google', 'Speech-to-Text v2 necesita el proyecto de Google Cloud (cuenta de servicio o VOZ_GOOGLE_PROYECTO)');
    const region = this.o.region ?? 'us';
    const t = cronometro();
    const d = await pedirJson<{
      results?: Array<{ alternatives?: Array<{ transcript?: string; confidence?: number }>; resultEndOffset?: string }>;
      metadata?: { totalBilledDuration?: string };
    }>('google', `${this.o.url ?? `https://${region}-speech.googleapis.com`}/v2/projects/${proyecto}/locations/${region}/recognizers/_:recognize`, {
      cabeceras: { 'content-type': 'application/json', ...(await this.auth.cabeceras()) },
      timeoutMs: this.o.timeoutMs ?? 30_000,
      senal: p.senal,
      cuerpo: JSON.stringify({
        config: { autoDecodingConfig: {}, model: this.modelo, languageCodes: [p.idioma], features: { enableAutomaticPunctuation: true } },
        content: p.audio.toString('base64'),
      }),
    });
    const alternativas = (d.results ?? []).map((r) => r.alternatives?.[0]).filter((a): a is { transcript?: string; confidence?: number } => Boolean(a));
    const texto = alternativas.map((a) => a.transcript ?? '').join(' ').replace(/\s+/g, ' ').trim();
    const confianzas = alternativas.map((a) => a.confidence).filter((c): c is number => typeof c === 'number' && c > 0);
    const facturado = d.metadata?.totalBilledDuration ? Number.parseFloat(d.metadata.totalBilledDuration) : null;
    return { texto, confianza: confianzas.length ? Math.min(...confianzas) : null, latenciaMs: t(), segundosAudio: Number.isFinite(facturado) ? facturado : null };
  }
}
