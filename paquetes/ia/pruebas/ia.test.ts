import { describe, expect, it } from 'vitest';
import { ErrorProveedor, ModelosPorTarea, crearModelo, extraerObjetoJson, type ConfigModeloTarea, type Tarea } from '../src/index.ts';

const TAREAS: Tarea[] = ['conversacion', 'guardian', 'riesgo', 'extraccion', 'informes', 'embeddings'];

describe('extraerObjetoJson', () => {
  it('lee JSON con o sin cercas de código', () => {
    expect(extraerObjetoJson('{"a":1}')).toEqual({ a: 1 });
    expect(extraerObjetoJson('Claro:\n```json\n{"nivel": 2}\n```')).toEqual({ nivel: 2 });
  });
  it('devuelve null si no hay JSON válido (no lo repara)', () => {
    expect(extraerObjetoJson('nivel: 2')).toBeNull();
    expect(extraerObjetoJson('{nivel: 2}')).toBeNull();
  });
});

describe('ModelosPorTarea', () => {
  it('exige la clave del proveedor configurado para cada tarea', () => {
    const tareas = Object.fromEntries(TAREAS.map((t) => [t, { proveedor: 'anthropic', modelo: 'x', timeoutMs: 1000 }])) as Record<Tarea, ConfigModeloTarea>;
    const m = new ModelosPorTarea({ claves: { gemini: 'k' }, tareas });
    expect(() => m.para('conversacion')).toThrow(/clave de API de anthropic/);
  });

  it('permite proveedores distintos por tarea', () => {
    const tareas = Object.fromEntries(TAREAS.map((t) => [t, { proveedor: 'gemini', modelo: 'g', timeoutMs: 1000 }])) as Record<Tarea, ConfigModeloTarea>;
    tareas.guardian = { proveedor: 'anthropic', modelo: 'c', timeoutMs: 1000 };
    const m = new ModelosPorTarea({ claves: { gemini: 'k1', anthropic: 'k2' }, tareas });
    expect(m.para('conversacion').proveedor).toBe('gemini');
    expect(m.para('guardian').proveedor).toBe('anthropic');
    expect(m.para('guardian')).toBe(m.para('guardian'));
  });
});

describe('errores de red', () => {
  // Puerto 9 (discard) en la propia máquina: una conexión real que falla, sin simular nada.
  it.each(['gemini', 'anthropic'] as const)('%s: un proveedor inalcanzable produce ErrorProveedor sin filtrar la clave', async (proveedor) => {
    const m = crearModelo({ proveedor, modelo: 'x', timeoutMs: 2000 }, 'CLAVE-SECRETA-123', 'http://127.0.0.1:9');
    const error = await m.responder({ instrucciones: 'x', mensajes: [{ rol: 'usuario', texto: 'hola' }] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErrorProveedor);
    expect(String((error as ErrorProveedor).message)).not.toContain('CLAVE-SECRETA');
    expect(String((error as ErrorProveedor).interno ?? '')).not.toContain('CLAVE-SECRETA');
  });
});

/**
 * Prueba contra el proveedor real. Se activa con VINCULAR_PRUEBA_IA_REAL=1 y las claves
 * GEMINI_API_KEY / ANTHROPIC_API_KEY y los modelos IA_MODELO_PRUEBA_GEMINI / _ANTHROPIC.
 */
const real = process.env.VINCULAR_PRUEBA_IA_REAL === '1';
describe.runIf(real)('proveedores reales', () => {
  const casos = [
    { proveedor: 'gemini' as const, clave: process.env.GEMINI_API_KEY, modelo: process.env.IA_MODELO_PRUEBA_GEMINI },
    { proveedor: 'anthropic' as const, clave: process.env.ANTHROPIC_API_KEY, modelo: process.env.IA_MODELO_PRUEBA_ANTHROPIC },
  ].filter((c) => c.clave && c.modelo);

  it.each(casos)('$proveedor responde texto, JSON y llamadas a herramientas', async (c) => {
    const m = crearModelo({ proveedor: c.proveedor, modelo: c.modelo!, timeoutMs: 60_000 }, c.clave!);
    const t = await m.responder({ instrucciones: 'Responde en español de Chile, en una frase.', mensajes: [{ rol: 'usuario', texto: 'Hola, ¿cómo estás?' }] });
    expect(t.tipo).toBe('texto');

    const j = await m.responder({ instrucciones: 'Devuelve {"ok": true}', mensajes: [{ rol: 'usuario', texto: 'ok' }], respuestaJson: true });
    expect(j.tipo === 'texto' && extraerObjetoJson(j.texto)).toEqual({ ok: true });

    const h = await m.responder({
      instrucciones: 'Usa siempre la herramienta hora_actual antes de responder.',
      mensajes: [{ rol: 'usuario', texto: '¿Qué hora es?' }],
      herramientas: [{ nombre: 'hora_actual', descripcion: 'Devuelve la hora actual', esquemaEntrada: { type: 'object', properties: {} } }],
    });
    expect(h.tipo).toBe('herramientas');
  }, 120_000);

  const modeloEmb = process.env.IA_MODELO_PRUEBA_EMBEDDINGS;
  it.runIf(Boolean(process.env.GEMINI_API_KEY && modeloEmb))('gemini entrega embeddings normalizados de la dimensión pedida', async () => {
    const m = crearModelo({ proveedor: 'gemini', modelo: modeloEmb!, timeoutMs: 60_000 }, process.env.GEMINI_API_KEY!);
    const r = await m.incrustar({ textos: ['Su nieta Camila vive en Temuco', 'le gusta el jardín'], uso: 'documento', dimension: 768 });
    expect(r.vectores).toHaveLength(2);
    expect(r.vectores[0]).toHaveLength(768);
    expect(Math.hypot(...r.vectores[0]!)).toBeCloseTo(1, 5);
  }, 60_000);
});

describe('embeddings', () => {
  it('Claude no ofrece embeddings y lo dice con un error claro', async () => {
    const m = crearModelo({ proveedor: 'anthropic', modelo: 'x', timeoutMs: 1000 }, 'k');
    await expect(m.incrustar({ textos: ['hola'], uso: 'consulta', dimension: 768 })).rejects.toThrow(/no ofrece embeddings/);
  });
});
