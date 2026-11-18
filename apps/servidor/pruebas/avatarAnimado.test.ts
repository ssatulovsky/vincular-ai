import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initializeLogger, voice } from '@livekit/agents';
import { Room } from '@livekit/rtc-node';
import { crearAplicacion, type Aplicacion } from '../src/api/servidor.ts';
import { encenderAvatar } from '../src/agente/avatar.ts';
import { cargarConfig } from '../src/config/config.ts';
import { abrirUsoAvatar, cerrarUsoAvatar, decidirAvatar, minutosAvatarDelMes, minutosAvatarHoy, type ConfigAvatarAnimado } from '../src/companero/avatarAnimado.ts';
import { configDePrueba, crearEscenario, type Escenario } from './escenario.ts';

const CONFIG: ConfigAvatarAnimado = { proveedor: 'lemonslice', apiKey: 'clave-de-prueba-lemonslice', maxMinutosDia: 20, inactividadS: 45 };
const TR = {
  urlPublica: 'wss://livekit.vincular.ejemplo.cl',
  urlInterna: 'ws://127.0.0.1:7880',
  apiKey: 'APIprueba',
  apiSecret: 'secreto-de-prueba-de-al-menos-32-caracteres',
  agente: 'vincular-companero',
  modeloStt: 'scribe_v2_realtime',
  finTurno: { minS: 1.2, maxS: 4 },
  puertoAgente: 8081,
};

let e: Escenario;
beforeAll(async () => {
  e = await crearEscenario();
});
afterAll(async () => e?.cerrar());

async function nuevaSesion(): Promise<string> {
  const r = await e.owner.query<{ id: string }>(`INSERT INTO sesion_conversacion (persona_id, iniciada_por, canal) VALUES ($1, 'persona', 'voz') RETURNING id`, [e.ids.persona]);
  return r.rows[0]!.id;
}

describe('avatar animado: cuándo se enciende', () => {
  const base = { config: CONFIG, avatarId: '00000000-0000-4000-8000-000000000001', modoEmergencia: false, minutosHoy: 0 };
  it('se enciende con configuración, retrato elegido y minutos disponibles', () => {
    expect(decidirAvatar(base)).toEqual({ usar: true });
  });
  it('sin configuración o sin retrato elegido, queda el retrato que respira', () => {
    expect(decidirAvatar({ ...base, config: null })).toEqual({ usar: false, motivo: 'sin_configuracion' });
    expect(decidirAvatar({ ...base, avatarId: null })).toEqual({ usar: false, motivo: 'sin_retrato' });
  });
  it('en una emergencia nunca se enciende (menos piezas que puedan fallar)', () => {
    expect(decidirAvatar({ ...base, modoEmergencia: true })).toEqual({ usar: false, motivo: 'emergencia' });
  });
  it('respeta el tope diario de minutos por persona', () => {
    expect(decidirAvatar({ ...base, minutosHoy: 19.9 })).toEqual({ usar: true });
    expect(decidirAvatar({ ...base, minutosHoy: 20 })).toEqual({ usar: false, motivo: 'tope_diario' });
    expect(decidirAvatar({ ...base, config: { ...CONFIG, maxMinutosDia: 0 } })).toEqual({ usar: false, motivo: 'tope_diario' });
  });
});

describe('avatar animado: configuración', () => {
  const base = { DATABASE_URL: 'postgres://x', CLAVE_CIFRADO: 'a'.repeat(64) };
  const lk = { LIVEKIT_URL_PUBLICA: 'wss://lk.ejemplo.cl', LIVEKIT_URL: 'ws://127.0.0.1:7880', LIVEKIT_API_KEY: 'APIx', LIVEKIT_API_SECRET: 's'.repeat(32) };
  it('apagado por defecto', () => {
    expect(cargarConfig({ ...base, ...lk }).avatarAnimado).toBeNull();
  });
  it('sin clave (o vacía en el .env) no se enciende', () => {
    expect(cargarConfig({ ...base, ...lk, AVATAR_ANIMADO: 'lemonslice' }).avatarAnimado).toBeNull();
    expect(cargarConfig({ ...base, ...lk, AVATAR_ANIMADO: 'lemonslice', LEMONSLICE_API_KEY: '' }).avatarAnimado).toBeNull();
  });
  it('sin tiempo real no hay avatar (el proveedor entra a la sala por la URL pública)', () => {
    expect(cargarConfig({ ...base, AVATAR_ANIMADO: 'lemonslice', LEMONSLICE_API_KEY: 'clave-larga-de-prueba' }).avatarAnimado).toBeNull();
  });
  it('con proveedor, clave y tiempo real queda encendido con sus topes', () => {
    const c = cargarConfig({ ...base, ...lk, AVATAR_ANIMADO: 'lemonslice', LEMONSLICE_API_KEY: 'clave-larga-de-prueba', AVATAR_ANIMADO_MAX_MINUTOS_DIA: '15' });
    expect(c.avatarAnimado).toEqual({ proveedor: 'lemonslice', apiKey: 'clave-larga-de-prueba', maxMinutosDia: 15, inactividadS: 45 });
  });
});

describe('avatar animado: minutos usados', () => {
  it('suma los minutos de hoy (incluido el abierto) y no los de ayer', async () => {
    const s = await nuevaSesion();
    await e.owner.query(`INSERT INTO uso_avatar (persona_id, sesion_id, proveedor, inicio, fin) VALUES ($1, $2, 'lemonslice', now() - interval '26 hours', now() - interval '25 hours')`, [e.ids.persona, s]);
    const antes = await minutosAvatarHoy(e.app.bd, e.ids.persona);
    await e.owner.query(`INSERT INTO uso_avatar (persona_id, sesion_id, proveedor, inicio, fin) VALUES ($1, $2, 'lemonslice', now() - interval '10 minutes', now() - interval '4 minutes')`, [e.ids.persona, s]);
    await e.owner.query(`INSERT INTO uso_avatar (persona_id, sesion_id, proveedor, inicio) VALUES ($1, $2, 'lemonslice', now() - interval '3 minutes')`, [e.ids.persona, s]);
    const despues = await minutosAvatarHoy(e.app.bd, e.ids.persona);
    // Si la prueba corre justo pasada la medianoche de Chile, parte de lo de hoy cae en ayer: se acepta el margen.
    expect(despues - antes).toBeGreaterThan(5.9);
    expect(despues - antes).toBeLessThan(9.1);
    await e.owner.query('DELETE FROM uso_avatar WHERE sesion_id = $1', [s]);
  });

  it('el registro se cierra una sola vez y guarda el primer motivo', async () => {
    const s = await nuevaSesion();
    const id = await abrirUsoAvatar(e.app.bd, e.ids.persona, s, 'lemonslice');
    await cerrarUsoAvatar(e.app.bd, id, 'desconectado');
    await cerrarUsoAvatar(e.app.bd, id, 'fin_sesion');
    const r = await e.owner.query<{ motivo_fin: string; fin: Date | null }>('SELECT motivo_fin, fin FROM uso_avatar WHERE id = $1', [id]);
    expect(r.rows[0]).toMatchObject({ motivo_fin: 'desconectado' });
    expect(r.rows[0]!.fin).not.toBeNull();
    const mes = new Date().toISOString().slice(0, 7);
    expect((await minutosAvatarDelMes(e.app.bd, mes)).some((x) => x.personaId === e.ids.persona)).toBe(true);
  });
});

describe('avatar animado dentro del agente', () => {
  let app: Aplicacion;
  let avatarId: string;
  beforeAll(async () => {
    initializeLogger({ pretty: false, level: 'fatal' });
    app = crearAplicacion(configDePrueba({ tiempoReal: TR, avatarAnimado: CONFIG }));
    // Un retrato (PNG de 1×1) elegido por la persona.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const r = await e.owner.query<{ id: string }>(
      `INSERT INTO avatar_propuesta (persona_id, ronda, genero, edad, entorno, imagen, mime, modelo, creado_por) VALUES ($1, gen_random_uuid(), 'femenina', 'mayor', 'jardin', $2, 'image/png', 'prueba', 'persona') RETURNING id`,
      [e.ids.persona, png],
    );
    avatarId = r.rows[0]!.id;
  });
  afterAll(async () => app?.bd.end());

  const registros: string[] = [];
  const registro = (msg: string) => void registros.push(msg);

  it('en emergencia no se intenta: la voz sale directa y no se registra uso', async () => {
    const s = await nuevaSesion();
    const sesion = new voice.AgentSession({});
    const r = await encenderAvatar({ app, room: new Room(), sesion, personaId: e.ids.persona, sesionId: s, avatarId, modoEmergencia: true, registro });
    expect(r).toBeNull();
    expect(sesion.output.audio).toBeNull();
    expect((await e.owner.query('SELECT 1 FROM uso_avatar WHERE sesion_id = $1', [s])).rowCount).toBe(0);
  });

  it('si el avatar no logra empezar, la conversación sigue con voz directa y queda el error registrado', async () => {
    const s = await nuevaSesion();
    const sesion = new voice.AgentSession({});
    // Sala sin conectar: el inicio falla de verdad, antes de llamar al proveedor.
    const r = await encenderAvatar({ app, room: new Room(), sesion, personaId: e.ids.persona, sesionId: s, avatarId, modoEmergencia: false, registro });
    expect(r).toBeNull();
    expect(sesion.output.audio).toBeNull();
    expect(registros).toContain('agente.avatar_falla_inicio');
    const u = await e.owner.query<{ motivo_fin: string; error: string; fin: Date | null }>('SELECT motivo_fin, error, fin FROM uso_avatar WHERE sesion_id = $1', [s]);
    expect(u.rows[0]).toMatchObject({ motivo_fin: 'error_inicio' });
    expect(u.rows[0]!.fin).not.toBeNull();
    expect(u.rows[0]!.error).not.toContain(CONFIG.apiKey);
  });
});
