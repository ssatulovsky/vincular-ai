import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { crearEscenario, pedir, type Escenario } from './escenario.ts';

/**
 * Turno por voz. Los proveedores de voz y de modelos apuntan a un puerto cerrado: se prueban los
 * caminos que no dependen de ellos (pedir repetir, texto sin audio, registros, validaciones).
 * El camino completo con proveedores reales: VINCULAR_PRUEBA_VOZ_REAL=1 (al final).
 */
let e: Escenario;
let url: string;
beforeAll(async () => {
  e = await crearEscenario();
  await e.f.listen({ port: 0, host: '127.0.0.1' });
  const dir = e.f.server.address() as { port: number };
  url = `ws://127.0.0.1:${dir.port}/api/conversacion/ws`;
});
afterAll(async () => e?.cerrar());

type Mensaje = Record<string, unknown> & { tipo: string };

async function conectar(token: string): Promise<{ ws: WebSocket; recibir: (hasta: string, plazoMs?: number) => Promise<Mensaje[]>; sesion: Mensaje }> {
  const ws = new WebSocket(url);
  const cola: Mensaje[] = [];
  ws.on('message', (m) => cola.push(JSON.parse(m.toString()) as Mensaje));
  await new Promise((r) => ws.once('open', r));
  const recibir = async (hasta: string, plazoMs = 15_000) => {
    const limite = Date.now() + plazoMs;
    while (Date.now() < limite) {
      const i = cola.findIndex((m) => m.tipo === hasta);
      if (i >= 0) return cola.splice(0, i + 1);
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`No llegó "${hasta}". Recibido: ${JSON.stringify(cola.map((m) => m.tipo))}`);
  };
  ws.send(JSON.stringify({ tipo: 'autenticar', token, canal: 'voz' }));
  const [sesion] = await recibir('sesion');
  return { ws, recibir, sesion: sesion! };
}

describe('turno por voz', () => {
  it('al conectar entrega los números de emergencia desde la configuración', async () => {
    const c = await conectar(e.tokens.dispositivo);
    expect(c.sesion.emergencia).toEqual({ samu: '131', prevencionSuicidio: '*4141' });
    c.ws.close();
  });

  it('deja en el registro del servidor por qué falló la voz, sin claves', async () => {
    const avisos: string[] = [];
    const espia = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => void avisos.push(String(m)));
    try {
      const c = await conectar(e.tokens.dispositivo);
      c.ws.send(JSON.stringify({ tipo: 'audio', mime: 'audio/webm;codecs=opus', datos: Buffer.alloc(5000, 1).toString('base64') }));
      await c.recibir('fin_turno');
      c.ws.close();
    } finally {
      espia.mockRestore();
    }
    const fallas = avisos.map((a) => JSON.parse(a) as { msg: string; error: string });
    expect(fallas.map((f) => f.msg)).toEqual(['voz.stt.falla', 'voz.tts.falla']);
    expect(fallas.every((f) => f.error.length > 0)).toBe(true);
    for (const a of avisos) expect(a).not.toMatch(/clave-de-prueba|xi-api-key/i);
  });

  it('si el reconocimiento no está disponible, pide repetir; si tampoco hay síntesis, deja el texto en pantalla', async () => {
    const c = await conectar(e.tokens.dispositivo);
    c.ws.send(JSON.stringify({ tipo: 'audio', mime: 'audio/webm;codecs=opus', datos: Buffer.alloc(5000, 1).toString('base64') }));
    const msgs = await c.recibir('fin_turno');
    expect(msgs.map((m) => m.tipo)).toEqual(['no_entendi', 'sin_audio', 'fin_turno']);
    expect(msgs[0]).toMatchObject({ motivo: 'reconocimiento_no_disponible', texto: expect.stringMatching(/me lo repite/i) });

    const m = await e.owner.query('SELECT stt_ok, pidio_repetir, tts_ok, orquestador_ms, turno_agente_id FROM medicion_voz WHERE sesion_id = $1', [c.sesion.sesionId]);
    expect(m.rows).toEqual([{ stt_ok: false, pidio_repetir: true, tts_ok: false, orquestador_ms: null, turno_agente_id: null }]);
    // Sin transcripción no se inventa un turno de la persona.
    const t = await e.owner.query('SELECT count(*)::int AS n FROM turno WHERE sesion_id = $1', [c.sesion.sesionId]);
    expect(t.rows[0].n).toBe(0);
    c.ws.close();
  });

  it('rechaza formatos que no son audio y audios demasiado grandes', async () => {
    const c = await conectar(e.tokens.dispositivo);
    c.ws.send(JSON.stringify({ tipo: 'audio', mime: 'text/html', datos: 'AAAA' }));
    expect((await c.recibir('error')).at(-1)).toMatchObject({ error: 'Formato de audio no admitido' });
    c.ws.send(JSON.stringify({ tipo: 'audio', mime: 'audio/webm', datos: Buffer.alloc(2 * 1024 * 1024 + 10).toString('base64') }));
    expect((await c.recibir('error')).at(-1)).toMatchObject({ error: 'Mensaje inválido' });
    c.ws.close();
  });

  it('el turno escrito también cierra con fin_turno', async () => {
    const c = await conectar(e.tokens.dispositivoAjeno);
    c.ws.send(JSON.stringify({ tipo: 'turno', texto: 'Hola' }));
    const msgs = await c.recibir('fin_turno');
    expect(msgs.map((m) => m.tipo)).toEqual(['respuesta', 'fin_turno']);
    c.ws.close();
  });
});

describe('voces del onboarding', () => {
  it('lista las voces ofrecidas con género y edad para filtrar, al menos una grave y una de cada género', async () => {
    const r = await pedir<{ porDefecto: string; voces: Array<{ id: string; grave: boolean; genero: string | null; edad: string | null }> }>(e.f, 'GET', '/api/voces', e.tokens.dispositivo);
    expect(r.datos.voces.length).toBeGreaterThanOrEqual(3);
    expect(r.datos.voces.some((v) => v.grave)).toBe(true);
    expect(new Set(r.datos.voces.map((v) => v.genero))).toEqual(new Set(['femenina', 'masculina']));
    expect(r.datos.voces.every((v) => v.edad !== null)).toBe(true);
    expect(r.datos.voces.map((v) => v.id)).toContain(r.datos.porDefecto);
  });

  it('la muestra solo se pide desde la tablet y responde 503 si la voz no está disponible', async () => {
    expect((await pedir(e.f, 'GET', '/api/voces/el-silvana/muestra', e.tokens.supervisor)).estado).toBe(403);
    expect((await pedir(e.f, 'GET', '/api/voces/no-ofrecida/muestra', e.tokens.dispositivo)).estado).toBe(400);
    expect((await pedir(e.f, 'GET', '/api/voces/el-silvana/muestra', e.tokens.dispositivo)).estado).toBe(503);
  });

  it('la persona elige voz y velocidad dentro de lo permitido', async () => {
    const base = { nombre: 'Aurora', personalidad: 'Tranquila' };
    expect((await pedir(e.f, 'PUT', '/api/mi-perfil-companero', e.tokens.dispositivo, { ...base, voz_id: 'g-chirp-femenina' })).estado).toBe(400);
    expect((await pedir(e.f, 'PUT', '/api/mi-perfil-companero', e.tokens.dispositivo, { ...base, velocidad_voz: 2 })).estado).toBe(400);
    expect((await pedir(e.f, 'PUT', '/api/mi-perfil-companero', e.tokens.dispositivo, { ...base, voz_id: 'el-martin', velocidad_voz: 0.85 })).estado).toBe(200);
    const r = await pedir<{ perfil: { voz_id: string; velocidad_voz: number } }>(e.f, 'GET', '/api/mi-perfil-companero', e.tokens.dispositivo);
    expect(r.datos.perfil).toMatchObject({ voz_id: 'el-martin', velocidad_voz: 0.85 });
  });
});

describe('pantalla de diseño del compañero', () => {
  it('se sirve con la misma política estricta, sin micrófono y con imágenes blob para los retratos', async () => {
    const r = await e.f.inject({ method: 'GET', url: '/companero' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['content-security-policy']).toContain("img-src 'self' data: blob:");
    expect(r.headers['permissions-policy']).toBe('microphone=()');
    // Los datos de la persona se pintan con textContent, nunca con innerHTML.
    expect(r.body).not.toContain('innerHTML');
  });
});

describe('prototipo de la tablet', () => {
  it('se sirve con una política de seguridad de contenido estricta', async () => {
    const r = await e.f.inject({ method: 'GET', url: '/tablet' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.body).toContain('Toque para hablar');
    // Los números de emergencia no están escritos en la página: llegan del servidor.
    expect(r.body).not.toMatch(/\b131\b|\*4141/);
  });
});
