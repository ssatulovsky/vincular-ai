import { randomUUID } from 'node:crypto';
import { esquemaParaGemini, pedirJson } from '../http.ts';
import { ErrorProveedor, type LlamadaHerramienta, type ModeloIA, type PeticionEmbeddings, type PeticionImagen, type PeticionModelo, type RespuestaEmbeddings, type RespuestaImagen, type RespuestaModelo } from '../tipos.ts';

interface Parte {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: unknown; id?: string };
  functionResponse?: { name: string; response: unknown; id?: string };
}

export interface OpcionesGemini {
  apiKey: string;
  modelo: string;
  /** Por defecto la API pública de Google AI. Para Vertex AI se usa su URL de región. */
  url?: string;
  timeoutMs?: number;
}

const URL_GEMINI = 'https://generativelanguage.googleapis.com/v1beta';

/** Gemini (API generateContent de Google) con llamadas a funciones. */
export class ModeloGemini implements ModeloIA {
  readonly proveedor = 'gemini' as const;
  readonly modelo: string;

  constructor(private readonly o: OpcionesGemini) {
    this.modelo = o.modelo;
  }

  async responder(p: PeticionModelo): Promise<RespuestaModelo> {
    const contents: Array<{ role: 'user' | 'model'; parts: Parte[] }> = [];
    for (const m of p.mensajes) {
      if (m.rol === 'usuario') contents.push({ role: 'user', parts: [{ text: m.texto }] });
      else if (m.rol === 'asistente') {
        const parts: Parte[] = [];
        if (m.texto) parts.push({ text: m.texto });
        for (const l of m.llamadas ?? []) {
          parts.push({ functionCall: { name: l.nombre, args: l.entrada ?? {} }, ...(l.firma ? { thoughtSignature: l.firma } : {}) });
        }
        contents.push({ role: 'model', parts });
      } else {
        const parte: Parte = { functionResponse: { name: m.nombre, response: { resultado: m.resultado } } };
        const ultimo = contents[contents.length - 1];
        if (ultimo?.role === 'user' && ultimo.parts.every((x) => x.functionResponse)) ultimo.parts.push(parte);
        else contents.push({ role: 'user', parts: [parte] });
      }
    }

    const generationConfig: Record<string, unknown> = { maxOutputTokens: p.maxTokens ?? 1024 };
    if (p.temperatura !== undefined) generationConfig.temperature = p.temperatura;
    if (p.respuestaJson) generationConfig.responseMimeType = 'application/json';

    const datos = (await pedirJson('gemini', `${this.o.url ?? URL_GEMINI}/models/${encodeURIComponent(this.o.modelo)}:generateContent`, {
      cabeceras: { 'x-goog-api-key': this.o.apiKey },
      timeoutMs: this.o.timeoutMs ?? 30_000,
      senal: p.senal,
      cuerpo: {
        systemInstruction: { parts: [{ text: p.instrucciones }] },
        contents,
        ...(p.herramientas?.length
          ? { tools: [{ functionDeclarations: p.herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, parameters: esquemaParaGemini(h.esquemaEntrada) })) }] }
          : {}),
        generationConfig,
      },
    })) as {
      candidates?: Array<{ content?: { parts?: Parte[] }; finishReason?: string }>;
      promptFeedback?: { blockReason?: string };
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
    };

    if (datos.promptFeedback?.blockReason) {
      throw new ErrorProveedor('gemini', 'El proveedor bloqueó la petición', undefined, `blockReason=${datos.promptFeedback.blockReason}`);
    }
    const partes = datos.candidates?.[0]?.content?.parts;
    if (!Array.isArray(partes)) {
      throw new ErrorProveedor('gemini', 'Respuesta sin contenido', undefined, `finishReason=${datos.candidates?.[0]?.finishReason ?? '?'}`);
    }
    const uso = {
      tokensEntrada: datos.usageMetadata?.promptTokenCount ?? 0,
      // Los tokens de razonamiento se cobran como salida.
      tokensSalida: (datos.usageMetadata?.candidatesTokenCount ?? 0) + (datos.usageMetadata?.thoughtsTokenCount ?? 0),
    };
    const texto = partes.filter((x) => !x.thought && x.text).map((x) => x.text).join('\n').trim();
    const llamadas: LlamadaHerramienta[] = partes
      .filter((x) => x.functionCall?.name)
      .map((x) => ({
        id: x.functionCall!.id ?? randomUUID(),
        nombre: x.functionCall!.name,
        entrada: x.functionCall!.args ?? {},
        ...(x.thoughtSignature ? { firma: x.thoughtSignature } : {}),
      }));
    if (llamadas.length > 0) return { tipo: 'herramientas', llamadas, ...(texto ? { texto } : {}), uso };
    return { tipo: 'texto', texto, uso };
  }

  async incrustar(p: PeticionEmbeddings): Promise<RespuestaEmbeddings> {
    const modelo = `models/${this.o.modelo}`;
    const datos = (await pedirJson('gemini', `${this.o.url ?? URL_GEMINI}/${modelo}:batchEmbedContents`, {
      cabeceras: { 'x-goog-api-key': this.o.apiKey },
      timeoutMs: this.o.timeoutMs ?? 30_000,
      senal: p.senal,
      cuerpo: {
        requests: p.textos.map((t) => ({
          model: modelo,
          content: { parts: [{ text: t }] },
          taskType: p.uso === 'documento' ? 'RETRIEVAL_DOCUMENT' : 'RETRIEVAL_QUERY',
          outputDimensionality: p.dimension,
        })),
      },
    })) as { embeddings?: Array<{ values?: number[] }> };
    const vectores = (datos.embeddings ?? []).map((e) => e.values ?? []);
    if (vectores.length !== p.textos.length || vectores.some((v) => v.length !== p.dimension)) {
      throw new ErrorProveedor('gemini', `Embeddings con forma inesperada (se esperaban ${p.textos.length} de dimensión ${p.dimension})`);
    }
    // Con dimensión reducida Gemini no entrega vectores normalizados: se normalizan para usar distancia coseno.
    return { vectores: vectores.map(normalizarVector), uso: { tokensEntrada: 0, tokensSalida: 0 } };
  }

  /**
   * Imagen con la API Interactions de Gemini (la que documenta Google para los modelos de imagen).
   * Las imágenes generadas llevan la marca de agua SynthID de Google.
   */
  async generarImagen(p: PeticionImagen): Promise<RespuestaImagen> {
    const datos = await pedirJson('gemini', `${this.o.url ?? URL_GEMINI}/interactions`, {
      cabeceras: { 'x-goog-api-key': this.o.apiKey },
      timeoutMs: this.o.timeoutMs ?? 60_000,
      senal: p.senal,
      cuerpo: {
        model: this.o.modelo,
        input: [{ type: 'text', text: p.descripcion }],
        response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: p.proporcion ?? '1:1' },
      },
    });
    const img = extraerImagen(datos);
    if (!img) throw new ErrorProveedor('gemini', 'La respuesta no trae una imagen', undefined, JSON.stringify(datos).slice(0, 300));
    return img;
  }

  async listarModelos(): Promise<string[]> {
    const datos = (await pedirJson('gemini', `${this.o.url ?? URL_GEMINI}/models?pageSize=200`, {
      metodo: 'GET',
      cabeceras: { 'x-goog-api-key': this.o.apiKey },
      timeoutMs: this.o.timeoutMs ?? 30_000,
    })) as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> };
    return (datos.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.some((x) => x === 'generateContent' || x === 'embedContent'))
      .map((m) => m.name.replace(/^models\//, ''));
  }
}

/**
 * Busca la imagen en la respuesta de Interactions: `output_image.data` (lo que leen los ejemplos de
 * Google) o, si no está, el último bloque `{ type: 'image', data }` dentro de `steps`.
 */
export function extraerImagen(datos: unknown): RespuestaImagen | null {
  const o = datos as { output_image?: { data?: string; mime_type?: string } } | null;
  const directo = o?.output_image?.data;
  if (typeof directo === 'string' && directo.length > 0) return { imagen: Buffer.from(directo, 'base64'), mime: o?.output_image?.mime_type ?? 'image/jpeg' };
  let ultimo: { data: string; mime_type?: string } | null = null;
  const recorrer = (x: unknown): void => {
    if (Array.isArray(x)) x.forEach(recorrer);
    else if (x && typeof x === 'object') {
      const r = x as Record<string, unknown>;
      if (r.type === 'image' && typeof r.data === 'string' && r.data.length > 0) ultimo = { data: r.data, ...(typeof r.mime_type === 'string' ? { mime_type: r.mime_type } : {}) };
      Object.values(r).forEach(recorrer);
    }
  };
  recorrer(datos);
  const u = ultimo as { data: string; mime_type?: string } | null;
  return u ? { imagen: Buffer.from(u.data, 'base64'), mime: u.mime_type ?? 'image/jpeg' } : null;
}

function normalizarVector(v: number[]): number[] {
  const n = Math.hypot(...v);
  return n > 0 ? v.map((x) => x / n) : v;
}
