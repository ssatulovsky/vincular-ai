import { generateKeyPairSync, createVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ErrorVoz,
  ReconocedorElevenLabs,
  SintetizadorElevenLabs,
  SintetizadorGoogle,
  AutenticadorGoogle,
  dividirEnFrases,
  firmarJwt,
  numeroParaVoz,
  prepararParaVoz,
  tasaErrorPalabras,
  validarCatalogo,
  vozDelCatalogo,
  type VozConfigurada,
} from '../src/index.ts';

describe('texto para la voz', () => {
  it('dice los números de emergencia dígito por dígito', () => {
    expect(numeroParaVoz('131')).toBe('uno tres uno');
    expect(numeroParaVoz('*4141')).toBe('asterisco cuatro uno cuatro uno');
    expect(prepararParaVoz('Llame al *4141 o al 131.', ['131', '*4141'])).toBe('Llame al asterisco cuatro uno cuatro uno o al uno tres uno.');
  });

  it('no toca otros números ni números más largos que contienen uno de emergencia', () => {
    expect(prepararParaVoz('Tiene 81 años y vive en el 1310.', ['131'])).toBe('Tiene 81 años y vive en el 1310.');
  });

  it('quita marcas de formato y emojis', () => {
    expect(prepararParaVoz('**Hola** 😊\n- uno\n# Título')).toBe('Hola uno Título');
  });

  it('divide en frases y une las muy cortas', () => {
    expect(dividirEnFrases('¡Hola! Qué bueno verla hoy por aquí. ¿Cómo amaneció? Yo bien.')).toEqual(['¡Hola! Qué bueno verla hoy por aquí.', '¿Cómo amaneció? Yo bien.']);
    expect(dividirEnFrases('Sin puntuación final')).toEqual(['Sin puntuación final']);
    expect(dividirEnFrases('')).toEqual([]);
  });
});

describe('tasa de error por palabra', () => {
  it('ignora tildes, mayúsculas y puntuación', () => {
    expect(tasaErrorPalabras('¿Cómo está, Rosa?', 'como esta rosa')).toBe(0);
  });
  it('cuenta sustituciones, omisiones e inserciones', () => {
    expect(tasaErrorPalabras('me duele el pecho', 'me duele el techo')).toBe(0.25);
    expect(tasaErrorPalabras('me duele el pecho', 'me duele pecho')).toBe(0.25);
    expect(tasaErrorPalabras('hola', 'hola hola hola')).toBe(2);
    expect(tasaErrorPalabras('', '')).toBe(0);
  });
});

describe('catálogo de voces', () => {
  const catalogo = JSON.parse(readFileSync(new URL('../../../config/voz/voces.json', import.meta.url), 'utf8'));
  it('el catálogo del repositorio es válido y ofrece 3 voces, una grave', () => {
    const c = validarCatalogo(catalogo);
    expect(c.ofrecidas).toHaveLength(3);
    expect(c.ofrecidas.some((id) => c.voces.find((v) => v.id === id)?.grave)).toBe(true);
  });
  it('rechaza ofrecer una voz que no existe y vuelve a la voz por defecto si falta', () => {
    expect(() => validarCatalogo({ ...catalogo, ofrecidas: ['no-existe'] })).toThrow(/no está en el catálogo/);
    const c = validarCatalogo(catalogo);
    expect(vozDelCatalogo(c, 'no-existe').id).toBe(c.porDefecto);
  });
});

describe('autenticación de Google', () => {
  it('firma un JWT RS256 verificable con la clave pública', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwt = firmarJwt({ client_email: 'sa@proyecto.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), project_id: 'p' }, 1_700_000_000);
    const [cab, cuerpo, firma] = jwt.split('.');
    expect(JSON.parse(Buffer.from(cuerpo!, 'base64url').toString())).toMatchObject({ iss: 'sa@proyecto.iam.gserviceaccount.com', aud: 'https://oauth2.googleapis.com/token', iat: 1_700_000_000, exp: 1_700_003_600 });
    expect(createVerify('RSA-SHA256').update(`${cab}.${cuerpo}`).verify(publicKey, Buffer.from(firma!, 'base64url'))).toBe(true);
  });
});

describe('errores de red de los proveedores de voz', () => {
  // Puerto 9 local: una conexión real que falla, sin simular respuestas.
  const voz: VozConfigurada = { id: 'x', proveedor: 'elevenlabs', motor: 'eleven_flash_v2_5', voz: 'abc', idioma: 'es', nombre: 'X' };
  it('ElevenLabs inalcanzable produce ErrorVoz sin filtrar la clave', async () => {
    const e = await new SintetizadorElevenLabs({ apiKey: 'CLAVE-SECRETA', url: 'http://127.0.0.1:9', timeoutMs: 2000 }).sintetizar({ texto: 'hola', voz }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErrorVoz);
    expect(JSON.stringify({ m: (e as ErrorVoz).message, i: (e as ErrorVoz).interno })).not.toContain('CLAVE-SECRETA');
    const r = await new ReconocedorElevenLabs({ apiKey: 'k', url: 'http://127.0.0.1:9', timeoutMs: 2000 }).reconocer({ audio: Buffer.from([1, 2]), mime: 'audio/webm', idioma: 'es' }).catch((x: unknown) => x);
    expect(r).toBeInstanceOf(ErrorVoz);
  });
  it('Google inalcanzable produce ErrorVoz; Gemini-TTS exige modelo configurado', async () => {
    const auth = new AutenticadorGoogle({ tipo: 'clave_api', clave: 'CLAVE-SECRETA' });
    const g = new SintetizadorGoogle(auth, { url: 'http://127.0.0.1:9', timeoutMs: 2000 });
    const e = await g.sintetizar({ texto: 'hola', voz: { ...voz, proveedor: 'google', motor: 'chirp3hd', voz: 'es-US-Chirp3-HD-Aoede', idioma: 'es-US' } }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErrorVoz);
    await expect(g.sintetizar({ texto: 'hola', voz: { ...voz, proveedor: 'google', motor: 'gemini', voz: 'Kore', idioma: 'es-419' } })).rejects.toThrow(/Gemini-TTS/);
  });
});

/**
 * Pruebas contra los proveedores reales: VINCULAR_PRUEBA_VOZ_REAL=1 con ELEVENLABS_API_KEY,
 * ELEVENLABS_VOZ_PRUEBA (voice_id) y/o VOZ_GOOGLE_CLAVE_API.
 */
describe.runIf(process.env.VINCULAR_PRUEBA_VOZ_REAL === '1')('proveedores de voz reales', () => {
  it.runIf(Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOZ_PRUEBA))('ElevenLabs sintetiza y Scribe transcribe ida y vuelta', async () => {
    const s = new SintetizadorElevenLabs({ apiKey: process.env.ELEVENLABS_API_KEY! });
    const audio = await s.sintetizar({ texto: 'Buenos días, ¿cómo amaneció hoy?', voz: { id: 'p', proveedor: 'elevenlabs', motor: 'eleven_flash_v2_5', voz: process.env.ELEVENLABS_VOZ_PRUEBA!, idioma: 'es', nombre: 'P' } });
    expect(audio.audio.length).toBeGreaterThan(1000);
    const t = await new ReconocedorElevenLabs({ apiKey: process.env.ELEVENLABS_API_KEY! }).reconocer({ audio: audio.audio, mime: 'audio/mpeg', idioma: 'es' });
    expect(tasaErrorPalabras('Buenos días, ¿cómo amaneció hoy?', t.texto)).toBeLessThan(0.3);
  }, 60_000);

  it.runIf(Boolean(process.env.VOZ_GOOGLE_CLAVE_API))('Google Chirp 3 HD sintetiza en español', async () => {
    const g = new SintetizadorGoogle(new AutenticadorGoogle({ tipo: 'clave_api', clave: process.env.VOZ_GOOGLE_CLAVE_API! }));
    const r = await g.sintetizar({ texto: 'Buenos días, ¿cómo amaneció hoy?', voz: { id: 'g', proveedor: 'google', motor: 'chirp3hd', voz: 'es-US-Chirp3-HD-Aoede', idioma: 'es-US', nombre: 'G' } });
    expect(r.audio.length).toBeGreaterThan(1000);
  }, 60_000);
});
