import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initializeLogger, voice } from '@livekit/agents';
import { Room } from '@livekit/rtc-node';
import { crearAplicacion, type Aplicacion } from '../src/api/servidor.ts';
import { encenderAvatar } from '../src/agente/avatar.ts';
import { cargarConfig } from '../src/config/config.ts';
import { abrirUsoAvatar, cerrarUsoAvatar, decidirAvatar, minutosAvatarDelMes, minutosAvatarHoy, type ConfigAvatarAnimado } from '../src/companero/avatarAnimado.ts';
import { crearCaraSimli, ErrorSimli, tokenSesionSimli } from '../src/companero/simli.ts';
import { caraSimliParaSesion, debePedirse, estadoCaraDePersona } from '../src/companero/caras.ts';
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

// ── Simli ────────────────────────────────────────────────────────────────────────────
// La API de Simli apunta a un puerto local cerrado: las llamadas fallan de verdad (sin simular).
const SIMLI_CERRADO = 'http://127.0.0.1:9';
const CARA_PRUEBA = 'f735e62c-dce7-4c0b-8e85-1c7e21774c45';

describe('Simli: configuración', () => {
  const base = { DATABASE_URL: 'postgres://x', CLAVE_CIFRADO: 'a'.repeat(64) };
  const lk = { LIVEKIT_URL_PUBLICA: 'wss://lk.ejemplo.cl', LIVEKIT_URL: 'ws://127.0.0.1:7880', LIVEKIT_API_KEY: 'APIx', LIVEKIT_API_SECRET: 's'.repeat(32) };
  it('con clave queda encendido, con la API oficial y sin cara de prueba', () => {
    const c = cargarConfig({ ...base, ...lk, AVATAR_ANIMADO: 'simli', SIMLI_API_KEY: 'clave-larga-de-prueba', SIMLI_CARA_PRUEBA: '', SIMLI_ZOOM: '' });
    expect(c.avatarAnimado).toEqual({ proveedor: 'simli', apiKey: 'clave-larga-de-prueba', apiUrl: 'https://api.simli.ai', caraPrueba: null, zoom: null, maxMinutosDia: 20, inactividadS: 45 });
  });
  it('acepta una cara de prueba del catálogo y el acercamiento', () => {
    const c = cargarConfig({ ...base, ...lk, AVATAR_ANIMADO: 'simli', SIMLI_API_KEY: 'clave-larga-de-prueba', SIMLI_CARA_PRUEBA: CARA_PRUEBA, SIMLI_ZOOM: '1.6' });
    expect(c.avatarAnimado).toMatchObject({ caraPrueba: CARA_PRUEBA, zoom: 1.6 });
  });
  it('una cara de prueba mal escrita se rechaza al arrancar (no falla en silencio)', () => {
    expect(() => cargarConfig({ ...base, ...lk, AVATAR_ANIMADO: 'simli', SIMLI_API_KEY: 'clave-larga-de-prueba', SIMLI_CARA_PRUEBA: 'Sara' })).toThrow(/SIMLI_CARA_PRUEBA/);
  });
  it('sin clave no se enciende', () => {
    expect(cargarConfig({ ...base, ...lk, AVATAR_ANIMADO: 'simli', SIMLI_API_KEY: '' }).avatarAnimado).toBeNull();
  });
});

describe('Simli: cuándo se pide la cara', () => {
  const hace = (horas: number) => new Date(Date.now() - horas * 3_600_000);
  it('se pide si no existe; no se repite mientras se construye o está lista', () => {
    expect(debePedirse(null)).toBe(true);
    expect(debePedirse({ estado: 'construyendo', actualizado_en: hace(30) })).toBe(false);
    expect(debePedirse({ estado: 'lista', actualizado_en: hace(300) })).toBe(false);
  });
  it('sin cupo, error o falla: se reintenta al día siguiente, no antes', () => {
    for (const estado of ['sin_cupo', 'error', 'fallida'] as const) {
      expect(debePedirse({ estado, actualizado_en: hace(2) })).toBe(false);
      expect(debePedirse({ estado, actualizado_en: hace(25) })).toBe(true);
    }
  });
  it('una solicitud perdida (más de 15 min) se puede repetir', () => {
    expect(debePedirse({ estado: 'solicitando', actualizado_en: hace(0.1) })).toBe(false);
    expect(debePedirse({ estado: 'solicitando', actualizado_en: hace(0.5) })).toBe(true);
  });
});

describe('Simli: caras y avatar en el agente', () => {
  const acceso = { apiKey: 'clave-de-prueba-simli', apiUrl: SIMLI_CERRADO };
  const CONFIG_SIMLI: ConfigAvatarAnimado = { proveedor: 'simli', ...acceso, caraPrueba: null, zoom: null, maxMinutosDia: 20, inactividadS: 45 };
  let avatarId: string;
  let app: Aplicacion;
  const registro = () => undefined;

  beforeAll(async () => {
    initializeLogger({ pretty: false, level: 'fatal' });
    app = crearAplicacion(configDePrueba({ tiempoReal: TR, avatarAnimado: CONFIG_SIMLI }));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const r = await e.owner.query<{ id: string }>(
      `INSERT INTO avatar_propuesta (persona_id, ronda, genero, edad, entorno, imagen, mime, modelo, creado_por) VALUES ($1, gen_random_uuid(), 'masculina', 'mayor', 'living', $2, 'image/png', 'prueba', 'persona') RETURNING id`,
      [e.ids.persona, png],
    );
    avatarId = r.rows[0]!.id;
  });
  afterAll(async () => app?.bd.end());

  const fila = async () => (await e.owner.query<{ estado: string; cara_id: string | null; detalle: string | null }>(`SELECT estado, cara_id, detalle FROM cara_avatar WHERE avatar_id = $1`, [avatarId])).rows[0];

  it('la primera conversación pide la cara en segundo plano y sigue con la cara de prueba', async () => {
    const trabajos: Array<Promise<void>> = [];
    const r = await caraSimliParaSesion({ bd: app.bd, acceso, caraPrueba: CARA_PRUEBA, personaId: e.ids.persona, avatarId, registro, trabajos });
    expect(r).toEqual({ caraId: CARA_PRUEBA, propia: false });
    expect(trabajos).toHaveLength(1);
    await Promise.all(trabajos);
    // Simli no respondió: queda registrado, sin la clave, para reintentar mañana.
    const f = await fila();
    expect(f).toMatchObject({ estado: 'error', cara_id: null });
    expect(f!.detalle).toContain('sin conexión');
    expect(f!.detalle).not.toContain(acceso.apiKey);
  });

  it('no vuelve a pedirla de inmediato (cuida el cupo de caras del plan)', async () => {
    const trabajos: Array<Promise<void>> = [];
    expect(await caraSimliParaSesion({ bd: app.bd, acceso, caraPrueba: null, personaId: e.ids.persona, avatarId, registro, trabajos })).toBeNull();
    expect(trabajos).toHaveLength(0);
  });

  it('si no se puede consultar el estado, sigue construyendo y no se pide otra', async () => {
    await e.owner.query(`UPDATE cara_avatar SET estado = 'construyendo', cara_id = 'cara-en-simli' WHERE avatar_id = $1`, [avatarId]);
    const trabajos: Array<Promise<void>> = [];
    expect(await caraSimliParaSesion({ bd: app.bd, acceso, caraPrueba: CARA_PRUEBA, personaId: e.ids.persona, avatarId, registro, trabajos })).toEqual({ caraId: CARA_PRUEBA, propia: false });
    expect(trabajos).toHaveLength(0);
    expect(await fila()).toMatchObject({ estado: 'construyendo' });
  });

  it('con la cara lista se usa la propia, y el panel ve su estado', async () => {
    await e.owner.query(`UPDATE cara_avatar SET estado = 'lista' WHERE avatar_id = $1`, [avatarId]);
    expect(await caraSimliParaSesion({ bd: app.bd, acceso, caraPrueba: CARA_PRUEBA, personaId: e.ids.persona, avatarId, registro })).toEqual({ caraId: 'cara-en-simli', propia: true });
    await e.owner.query(`INSERT INTO perfil_companero (persona_id, nombre, avatar_id) VALUES ($1, 'Rosa', $2) ON CONFLICT (persona_id) DO UPDATE SET avatar_id = $2`, [e.ids.persona, avatarId]);
    expect((await estadoCaraDePersona(app.bd, e.ids.persona))?.estado).toBe('lista');
  });

  it('si Simli no acepta la sesión, la conversación sigue con voz directa y queda el error', async () => {
    const s = await nuevaSesion();
    const sesion = new voice.AgentSession({});
    const r = await encenderAvatar({ app, room: new Room(), sesion, personaId: e.ids.persona, sesionId: s, avatarId, modoEmergencia: false, registro });
    expect(r).toBeNull();
    expect(sesion.output.audio).toBeNull();
    const u = await e.owner.query<{ proveedor: string; motivo_fin: string; error: string }>('SELECT proveedor, motivo_fin, error FROM uso_avatar WHERE sesion_id = $1', [s]);
    expect(u.rows[0]).toMatchObject({ proveedor: 'simli', motivo_fin: 'error_inicio' });
    expect(u.rows[0]!.error).not.toContain(acceso.apiKey);
  });

  it('sin cara lista ni cara de prueba, no hay avatar ni minutos cobrados', async () => {
    await e.owner.query(`UPDATE cara_avatar SET estado = 'construyendo' WHERE avatar_id = $1`, [avatarId]);
    const s = await nuevaSesion();
    const sesion = new voice.AgentSession({});
    expect(await encenderAvatar({ app, room: new Room(), sesion, personaId: e.ids.persona, sesionId: s, avatarId, modoEmergencia: false, registro })).toBeNull();
    expect((await e.owner.query('SELECT 1 FROM uso_avatar WHERE sesion_id = $1', [s])).rowCount).toBe(0);
  });
});

describe('Simli: cliente HTTP', () => {
  const acceso = { apiKey: 'clave-de-prueba-simli', apiUrl: SIMLI_CERRADO };
  it('sin conexión falla con un error propio, sin la clave', async () => {
    const intento = tokenSesionSimli(acceso, { caraId: CARA_PRUEBA, maxSesionS: 600, maxInactividadS: 45, zoom: null });
    await expect(intento).rejects.toBeInstanceOf(ErrorSimli);
    await expect(intento).rejects.toThrow(/sin conexión/);
    await expect(crearCaraSimli(acceso, { imagen: Buffer.from('x'), mime: 'image/png' }, 'vincular-prueba')).rejects.toMatchObject({ estado: null, sinCupo: false });
  });
  it('un 403 al crear la cara se reconoce como falta de cupo', () => {
    expect(new ErrorSimli(403, 'x').sinCupo).toBe(true);
    expect(new ErrorSimli(401, 'x').sinCupo).toBe(false);
  });
});
