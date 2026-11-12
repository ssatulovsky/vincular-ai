import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ConfigIA, Tarea } from '@vincular/ia';
import type { ContactosEmergencia } from '@vincular/seguridad-clinica';
import type { ConfigVoz } from '@vincular/voz';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const proveedor = z.enum(['gemini', 'anthropic']);
const TAREAS: Tarea[] = ['conversacion', 'guardian', 'riesgo', 'extraccion', 'informes', 'embeddings'];

const esquemaEntornoVoz = z.object({
  VOZ_CATALOGO: z.string().default(path.join(RAIZ, 'config/voz/voces.json')),
  VOZ_STT_PROVEEDOR: z.enum(['google', 'elevenlabs']).default('google'),
  // Google Chirp 3 no tiene es-CL: es-US por defecto. ElevenLabs usa "es".
  VOZ_STT_IDIOMA: z.string().optional(),
  // Bajo esta confianza (si el proveedor la informa) se pide repetir, salvo que haya señal de riesgo.
  VOZ_UMBRAL_CONFIANZA: z.coerce.number().min(0).max(1).default(0.5),
  VOZ_GOOGLE_CUENTA_SERVICIO: z.string().optional(),
  VOZ_GOOGLE_CLAVE_API: z.string().optional(),
  VOZ_GOOGLE_PROYECTO: z.string().optional(),
  VOZ_GOOGLE_MODELO_GEMINI: z.string().optional(),
  VOZ_GOOGLE_REGION_STT: z.string().default('us'),
  VOZ_GOOGLE_MODELO_STT: z.string().default('chirp_3'),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_MODELO_STT: z.string().default('scribe_v3'),
  PROTOCOLO_EMERGENCIA: z.string().default(path.join(RAIZ, 'config/protocolo-emergencia.json')),
});

const esquemaEntorno = esquemaEntornoVoz.extend({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PUERTO: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().min(1, 'Falta DATABASE_URL (conexión con el rol vincular_app)'),
  CLAVE_CIFRADO: z.string().regex(/^[0-9a-f]{64}$/i, 'CLAVE_CIFRADO debe tener 64 caracteres hexadecimales (openssl rand -hex 32)'),
  GEMINI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GEMINI_URL: z.string().url().optional(),
  ANTHROPIC_URL: z.string().url().optional(),
  // Proveedor por defecto para todas las tareas; cada tarea puede sobrescribirlo (ver esquemaTarea).
  IA_PROVEEDOR: proveedor.default('gemini'),
  // Cuánto espera el orquestador al clasificador de riesgo antes de responder con el nivel de las reglas.
  RIESGO_ESPERA_CLASIFICADOR_MS: z.coerce.number().int().positive().default(4000),
  SESION_ACCESO_HORAS: z.coerce.number().int().positive().default(12),
  PRECIOS_MODELOS: z.string().default(path.join(RAIZ, 'config/precios-modelos.json')),
  // Minutos sin turnos nuevos para considerar terminada una sesión y extraer su memoria.
  MEMORIA_MINUTOS_INACTIVIDAD: z.coerce.number().int().positive().default(30),
});

const esquemaTarea = z.object({
  proveedor: proveedor.optional(),
  modelo: z.string().min(1).optional(),
  timeoutMs: z.coerce.number().int().positive().optional(),
});

const esquemaProtocolo = z.object({
  numeros: z.object({
    samu: z.object({ numero: z.string().min(1), verificado: z.boolean() }),
    prevencionSuicidio: z.object({ numero: z.string().min(1), verificado: z.boolean() }),
    fonoMayor: z.object({ numero: z.string(), verificado: z.boolean() }),
  }),
});

const TIMEOUT_POR_DEFECTO: Record<Tarea, number> = { conversacion: 30_000, guardian: 10_000, riesgo: 10_000, extraccion: 30_000, informes: 120_000, embeddings: 15_000 };

export interface Config {
  entorno: 'development' | 'test' | 'production';
  puerto: number;
  host: string;
  databaseUrl: string;
  claveCifrado: Buffer;
  ia: ConfigIA;
  /** Tareas sin modelo configurado: el servidor arranca, pero esas tareas no están disponibles. */
  tareasSinModelo: Tarea[];
  esperaClasificadorMs: number;
  sesionAccesoHoras: number;
  emergencia: ContactosEmergencia & { verificados: boolean };
  rutaPrecios: string;
  memoriaMinutosInactividad: number;
  voz: { catalogo: string; umbralConfianza: number; servicios: ConfigVoz };
}

export function cargarConfig(entorno: NodeJS.ProcessEnv = process.env): Config {
  const r = esquemaEntorno.safeParse(entorno);
  if (!r.success) {
    throw new Error(`Configuración inválida:\n${r.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  const e = r.data;

  const tareasSinModelo: Tarea[] = [];
  const tareas = {} as ConfigIA['tareas'];
  for (const t of TAREAS) {
    const T = t.toUpperCase();
    const v = esquemaTarea.safeParse({
      proveedor: entorno[`IA_PROVEEDOR_${T}`] || undefined,
      modelo: entorno[`IA_MODELO_${T}`] || undefined,
      timeoutMs: entorno[`IA_TIMEOUT_MS_${T}`] || undefined,
    });
    if (!v.success) throw new Error(`Configuración inválida para la tarea ${t}: ${v.error.issues.map((i) => i.message).join('; ')}`);
    if (!v.data.modelo) tareasSinModelo.push(t);
    tareas[t] = { proveedor: v.data.proveedor ?? e.IA_PROVEEDOR, modelo: v.data.modelo ?? '', timeoutMs: v.data.timeoutMs ?? TIMEOUT_POR_DEFECTO[t] };
  }

  const protocolo = esquemaProtocolo.parse(JSON.parse(readFileSync(e.PROTOCOLO_EMERGENCIA, 'utf8')));
  const verificados = protocolo.numeros.samu.verificado && protocolo.numeros.prevencionSuicidio.verificado;

  if (e.NODE_ENV === 'production') {
    if (!verificados) throw new Error('Los números de emergencia no están verificados (config/protocolo-emergencia.json). El servidor no arranca en producción sin esa verificación.');
    for (const t of ['conversacion', 'guardian', 'riesgo'] as const) {
      if (tareasSinModelo.includes(t)) throw new Error(`Falta IA_MODELO_${t.toUpperCase()}: es obligatorio en producción.`);
    }
  }

  return {
    entorno: e.NODE_ENV,
    puerto: e.PUERTO,
    host: e.HOST,
    databaseUrl: e.DATABASE_URL,
    claveCifrado: Buffer.from(e.CLAVE_CIFRADO, 'hex'),
    ia: {
      claves: { ...(e.GEMINI_API_KEY ? { gemini: e.GEMINI_API_KEY } : {}), ...(e.ANTHROPIC_API_KEY ? { anthropic: e.ANTHROPIC_API_KEY } : {}) },
      urls: { ...(e.GEMINI_URL ? { gemini: e.GEMINI_URL } : {}), ...(e.ANTHROPIC_URL ? { anthropic: e.ANTHROPIC_URL } : {}) },
      tareas,
    },
    tareasSinModelo,
    esperaClasificadorMs: e.RIESGO_ESPERA_CLASIFICADOR_MS,
    sesionAccesoHoras: e.SESION_ACCESO_HORAS,
    rutaPrecios: e.PRECIOS_MODELOS,
    memoriaMinutosInactividad: e.MEMORIA_MINUTOS_INACTIVIDAD,
    voz: configVozDe(e),
    emergencia: { samu: protocolo.numeros.samu.numero, prevencionSuicidio: protocolo.numeros.prevencionSuicidio.numero, verificados },
  };
}

function configVozDe(e: z.infer<typeof esquemaEntornoVoz>): Config['voz'] {
  return {
    catalogo: e.VOZ_CATALOGO,
    umbralConfianza: e.VOZ_UMBRAL_CONFIANZA,
    servicios: {
      google: {
        ...(e.VOZ_GOOGLE_CUENTA_SERVICIO ? { cuentaServicio: e.VOZ_GOOGLE_CUENTA_SERVICIO } : {}),
        ...(e.VOZ_GOOGLE_CLAVE_API ? { claveApi: e.VOZ_GOOGLE_CLAVE_API } : {}),
        ...(e.VOZ_GOOGLE_PROYECTO ? { proyecto: e.VOZ_GOOGLE_PROYECTO } : {}),
        ...(e.VOZ_GOOGLE_MODELO_GEMINI ? { modeloGemini: e.VOZ_GOOGLE_MODELO_GEMINI } : {}),
        regionStt: e.VOZ_GOOGLE_REGION_STT,
        modeloStt: e.VOZ_GOOGLE_MODELO_STT,
      },
      elevenlabs: { ...(e.ELEVENLABS_API_KEY ? { apiKey: e.ELEVENLABS_API_KEY } : {}), modeloStt: e.ELEVENLABS_MODELO_STT },
      reconocimiento: { proveedor: e.VOZ_STT_PROVEEDOR, idioma: e.VOZ_STT_IDIOMA ?? (e.VOZ_STT_PROVEEDOR === 'google' ? 'es-US' : 'es') },
    },
  };
}

/**
 * Solo la configuración de voz y los números de emergencia, para las herramientas de benchmark
 * (no necesitan base de datos ni claves de modelos).
 */
export function cargarConfigVoz(entorno: NodeJS.ProcessEnv = process.env): { voz: Config['voz']; emergencia: ContactosEmergencia } {
  const e = esquemaEntornoVoz.parse(entorno);
  const protocolo = esquemaProtocolo.parse(JSON.parse(readFileSync(e.PROTOCOLO_EMERGENCIA, 'utf8')));
  return { voz: configVozDe(e), emergencia: { samu: protocolo.numeros.samu.numero, prevencionSuicidio: protocolo.numeros.prevencionSuicidio.numero } };
}
