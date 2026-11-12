import { pedirJson } from '../http.ts';
import { ErrorProveedor, type LlamadaHerramienta, type ModeloIA, type PeticionModelo, type RespuestaModelo } from '../tipos.ts';

interface Bloque {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

export interface OpcionesAnthropic {
  apiKey: string;
  modelo: string;
  url?: string;
  timeoutMs?: number;
}

const URL_ANTHROPIC = 'https://api.anthropic.com/v1';

/** Claude (API de Mensajes de Anthropic) con uso de herramientas. */
export class ModeloAnthropic implements ModeloIA {
  readonly proveedor = 'anthropic' as const;
  readonly modelo: string;

  constructor(private readonly o: OpcionesAnthropic) {
    this.modelo = o.modelo;
  }

  private cabeceras(): Record<string, string> {
    return { 'x-api-key': this.o.apiKey, 'anthropic-version': '2023-06-01' };
  }

  async responder(p: PeticionModelo): Promise<RespuestaModelo> {
    const messages: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = [];
    for (const m of p.mensajes) {
      if (m.rol === 'usuario') messages.push({ role: 'user', content: [{ type: 'text', text: m.texto }] });
      else if (m.rol === 'asistente') {
        const content: Bloque[] = [];
        if (m.texto) content.push({ type: 'text', text: m.texto });
        for (const l of m.llamadas ?? []) content.push({ type: 'tool_use', id: l.id, name: l.nombre, input: l.entrada ?? {} });
        messages.push({ role: 'assistant', content });
      } else {
        // Resultados consecutivos van juntos en un solo mensaje del usuario.
        const bloque = { type: 'tool_result', tool_use_id: m.llamadaId, content: JSON.stringify(m.resultado) };
        const ultimo = messages[messages.length - 1];
        if (ultimo?.role === 'user' && ultimo.content.every((b) => (b as Bloque).type === 'tool_result')) ultimo.content.push(bloque);
        else messages.push({ role: 'user', content: [bloque] });
      }
    }

    // Claude no tiene un modo JSON nativo en esta API: se pide en las instrucciones y se valida al leer.
    const system = p.respuestaJson ? `${p.instrucciones}\n\nResponde SOLO con un objeto JSON válido, sin texto antes ni después.` : p.instrucciones;
    const datos = (await pedirJson('anthropic', `${this.o.url ?? URL_ANTHROPIC}/messages`, {
      cabeceras: this.cabeceras(),
      timeoutMs: this.o.timeoutMs ?? 30_000,
      senal: p.senal,
      cuerpo: {
        model: this.o.modelo,
        max_tokens: p.maxTokens ?? 1024,
        system,
        messages,
        ...(p.temperatura !== undefined ? { temperature: p.temperatura } : {}),
        ...(p.herramientas?.length ? { tools: p.herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, input_schema: h.esquemaEntrada })) } : {}),
      },
    })) as { content?: Bloque[]; usage?: { input_tokens?: number; output_tokens?: number } };

    if (!Array.isArray(datos.content)) throw new ErrorProveedor('anthropic', 'Respuesta sin contenido');
    const uso = { tokensEntrada: datos.usage?.input_tokens ?? 0, tokensSalida: datos.usage?.output_tokens ?? 0 };
    const texto = datos.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim();
    const llamadas: LlamadaHerramienta[] = datos.content
      .filter((b) => b.type === 'tool_use' && b.id && b.name)
      .map((b) => ({ id: b.id!, nombre: b.name!, entrada: b.input ?? {} }));
    if (llamadas.length > 0) return { tipo: 'herramientas', llamadas, ...(texto ? { texto } : {}), uso };
    return { tipo: 'texto', texto, uso };
  }

  async listarModelos(): Promise<string[]> {
    const datos = (await pedirJson('anthropic', `${this.o.url ?? URL_ANTHROPIC}/models?limit=100`, {
      metodo: 'GET',
      cabeceras: this.cabeceras(),
      timeoutMs: this.o.timeoutMs ?? 30_000,
    })) as { data?: Array<{ id: string }> };
    return (datos.data ?? []).map((m) => m.id);
  }
}
