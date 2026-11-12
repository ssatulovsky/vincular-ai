import { randomUUID } from 'node:crypto';
import { esquemaParaGemini, pedirJson } from '../http.ts';
import { ErrorProveedor, type LlamadaHerramienta, type ModeloIA, type PeticionModelo, type RespuestaModelo } from '../tipos.ts';

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

  async listarModelos(): Promise<string[]> {
    const datos = (await pedirJson('gemini', `${this.o.url ?? URL_GEMINI}/models?pageSize=200`, {
      metodo: 'GET',
      cabeceras: { 'x-goog-api-key': this.o.apiKey },
      timeoutMs: this.o.timeoutMs ?? 30_000,
    })) as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> };
    return (datos.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''));
  }
}
