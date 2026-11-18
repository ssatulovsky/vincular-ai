import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ConfigIA, Tarea } from '@vincular/ia';
import type { ContactosEmergencia } from '@vincular/seguridad-clinica';
import type { ConfigVoz } from '@vincular/voz';
import type { PlazosMedicacion } from '../medicacion/agenda.ts';
import type { ConfigTwilio } from '../escalamiento/twilio.ts';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const proveedor = z.enum(['gemini', 'anthropic']);
const TAREAS: Tarea[] = ['conversacion', 'conversacion_respaldo', 'guardian', 'riesgo', 'extraccion', 'informes', 'embeddings', 'imagenes'];

const esquemaEntornoVoz = z.object({
  VOZ_CATALOGO: z.string().default(path.join(RAIZ, 'config/voz/voces.json')),
  VOZ_STT_PROVEEDOR: z.enum(['google', 'elevenlabs']).default('google'),
  // Google Chirp 3 no tiene es-CL: es-US por defecto. ElevenLabs usa "es".
  VOZ_STT_IDIOMA: z
    .string()
    .regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/, 'debe ser un código de idioma como es o es-US, no una palabra como "spanish" (o déjela vacía)')
    .optional(),
  // Bajo esta confianza (si el proveedor la informa) se pide repetir, salvo que haya señal de riesgo.
  VOZ_UMBRAL_CONFIANZA: z.coerce.number().min(0).max(1).default(0.5),
  // Se revisa al arrancar: si no, la falla aparece recién en la primera conversación con voz.
  VOZ_GOOGLE_CUENTA_SERVICIO: z
    .string()
    .refine((ruta) => path.isAbsolute(ruta) && existsSync(ruta), 'debe ser la ruta absoluta de un archivo que exista (p. ej. /opt/vincular-ai/google-voz.json), o quedar vacía si no usa Google')
    .optional(),
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
  // Enfermero digital. TODO(clinico): plazos definitivos.
  MEDICACION_SEGUNDO_AVISO_MIN: z.coerce.number().int().positive().default(30),
  MEDICACION_SIN_RESPUESTA_MIN: z.coerce.number().int().positive().default(30),
  // Iniciar el planificador (recordatorios, memoria) dentro del servidor.
  PLANIFICADOR: z.enum(['si', 'no']).default('si'),
  // ── Escalamiento (Sprint 5) ──
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  // Número de origen en E.164 (necesario para llamadas) o MessagingServiceSid (MG…) solo para SMS.
  TWILIO_ORIGEN: z.string().optional(),
  TWILIO_IDIOMA: z.string().default('es-MX'),
  TWILIO_VOZ: z.string().optional(),
  // URL pública del servidor (https://…), para los webhooks de Twilio: acuse con "1" y estados.
  BASE_URL_PUBLICA: z.string().url().optional(),
  // ── Conversación en tiempo real (LiveKit) ──
  // URL pública para la tablet (wss://…) y URL interna para el agente (ws://127.0.0.1:7880).
  LIVEKIT_URL_PUBLICA: z.string().url().optional(),
  LIVEKIT_URL: z.string().url().optional(),
  LIVEKIT_API_KEY: z.string().min(3).optional(),
  LIVEKIT_API_SECRET: z.string().min(32, 'LIVEKIT_API_SECRET debe tener al menos 32 caracteres').optional(),
  LIVEKIT_AGENTE: z.string().regex(/^[a-z0-9-]{3,40}$/).default('vincular-companero'),
  // Voz a texto en tiempo real (ElevenLabs Scribe realtime) y espera para dar por terminado el turno.
  ELEVENLABS_MODELO_STT_TIEMPO_REAL: z.string().default('scribe_v2_realtime'),
  TIEMPO_REAL_FIN_TURNO_MIN_S: z.coerce.number().min(0.3).max(5).default(1.2),
  TIEMPO_REAL_FIN_TURNO_MAX_S: z.coerce.number().min(0.5).max(10).default(4),
  /** Puerto local de salud del proceso del agente (solo 127.0.0.1). */
  TIEMPO_REAL_PUERTO_AGENTE: z.coerce.number().int().min(1024).max(65535).default(8081),
  // Diseño del compañero: grupos de 3 retratos que se pueden crear por persona y día (costo).
  AVATAR_RONDAS_POR_DIA: z.coerce.number().int().min(0).max(20).default(4),
  // ── Avatar animado en tiempo real (opcional, con costo por minuto) ──
  // 'ninguno' = la tablet muestra el retrato que respira (sin costo). 'lemonslice' = el retrato
  // elegido habla con movimiento de boca y rostro. Necesita LEMONSLICE_API_KEY.
  AVATAR_ANIMADO: z.enum(['ninguno', 'lemonslice']).default('ninguno'),
  LEMONSLICE_API_KEY: z.string().min(10).optional(),
  // Tope de minutos de avatar por persona y día (hora de Chile): pasado el tope, vuelve el retrato.
  AVATAR_ANIMADO_MAX_MINUTOS_DIA: z.coerce.number().int().min(0).max(600).default(20),
  // Segundos sin hablar tras los cuales el proveedor cierra el avatar (deja de cobrar).
  AVATAR_ANIMADO_INACTIVIDAD_S: z.coerce.number().int().min(15).max(600).default(45),
  ESCALAMIENTO_EMERGENCIA_SIN_RESPUESTA_MIN: z.coerce.number().int().positive().default(10),
});

const esquemaTarea = z.object({
  proveedor: proveedor.optional(),
  modelo: z
    .string()
    .min(1)
    // Una clave pegada como modelo se guardaría en los registros de uso: se rechaza al arrancar.
    .refine((m) => !/^(AIza|AQ\.|sk-)/.test(m), 'parece una clave de API, no un nombre de modelo (la clave va en GEMINI_API_KEY o ANTHROPIC_API_KEY)')
    .optional(),
  timeoutMs: z.coerce.number().int().positive().optional(),
  razonamiento: z.enum(['low', 'medium', 'high', 'predeterminado'], { message: 'debe ser low, medium, high o predeterminado' }).optional(),
});

const esquemaProtocolo = z.object({
  numeros: z.object({
    samu: z.object({ numero: z.string().min(1), verificado: z.boolean() }),
    prevencionSuicidio: z.object({ numero: z.string().min(1), verificado: z.boolean() }),
    fonoMayor: z.object({ numero: z.string(), verificado: z.boolean() }),
  }),
});

/**
 * Razonamiento por defecto. La conversación va en low: responde en voz y cada segundo se nota; con
 * el valor por defecto de Gemini (medium) tardaba 4–7 s y a veces gastaba el tope pensando. El
 * riesgo y el guardián quedan con el del modelo (criterio conservador). IA_RAZONAMIENTO_<TAREA>
 * lo cambia; "predeterminado" no envía nada.
 */
const RAZONAMIENTO_POR_DEFECTO: Partial<Record<Tarea, 'low' | 'medium' | 'high'>> = { conversacion: 'low', conversacion_respaldo: 'low' };
// La conversación se espera poco: si el modelo principal se demora, responde el de respaldo.
const TIMEOUT_POR_DEFECTO: Record<Tarea, number> = { conversacion: 15_000, conversacion_respaldo: 10_000, guardian: 10_000, riesgo: 10_000, extraccion: 30_000, informes: 120_000, embeddings: 15_000, imagenes: 90_000 };

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
  medicacion: PlazosMedicacion;
  planificador: boolean;
  companero: { maxRondasAvatarDia: number };
  /** null = sin avatar animado: la tablet muestra el retrato (requiere tiempo real). */
  avatarAnimado: { proveedor: 'lemonslice'; apiKey: string; maxMinutosDia: number; inactividadS: number } | null;
  /** null = sin tiempo real (la tablet usa el modo manos libres por turnos). */
  tiempoReal: {
    urlPublica: string;
    urlInterna: string;
    apiKey: string;
    apiSecret: string;
    agente: string;
    modeloStt: string;
    finTurno: { minS: number; maxS: number };
    puertoAgente: number;
  } | null;
  escalamiento: {
    twilio: ConfigTwilio | null;
    urlPublica: string | null;
    voz: { idioma: string; voz?: string | undefined };
    emergenciaSinRespuestaMin: number;
  };
}

/**
 * Una variable vacía en el .env ("BASE_URL_PUBLICA=") vale como no definida: así el .env.example se
 * copia tal cual y solo se completan las que se usan.
 */
function sinVacias(entorno: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(entorno).filter(([, v]) => v !== undefined && v.trim() !== ''));
}

export function cargarConfig(entornoOriginal: NodeJS.ProcessEnv = process.env): Config {
  const entorno = sinVacias(entornoOriginal);
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
      razonamiento: entorno[`IA_RAZONAMIENTO_${T}`] || undefined,
    });
    if (!v.success) throw new Error(`Configuración inválida para la tarea ${t}: ${v.error.issues.map((i) => i.message).join('; ')}`);
    if (!v.data.modelo) tareasSinModelo.push(t);
    const razonamiento = v.data.razonamiento ?? RAZONAMIENTO_POR_DEFECTO[t];
    tareas[t] = {
      proveedor: v.data.proveedor ?? e.IA_PROVEEDOR,
      modelo: v.data.modelo ?? '',
      timeoutMs: v.data.timeoutMs ?? TIMEOUT_POR_DEFECTO[t],
      ...(razonamiento && razonamiento !== 'predeterminado' ? { razonamiento } : {}),
    };
  }

  // Informes: si no se configuró un modelo propio, usan el de la conversación.
  if (!tareas.informes.modelo && tareas.conversacion.modelo) {
    tareas.informes = { ...tareas.informes, proveedor: tareas.conversacion.proveedor, modelo: tareas.conversacion.modelo };
    const i = tareasSinModelo.indexOf('informes');
    if (i >= 0) tareasSinModelo.splice(i, 1);
  }
  // Respaldo de la conversación: si no se configuró, usa el modelo rápido del guardián.
  if (!tareas.conversacion_respaldo.modelo && tareas.guardian.modelo) {
    tareas.conversacion_respaldo = { ...tareas.conversacion_respaldo, proveedor: tareas.guardian.proveedor, modelo: tareas.guardian.modelo };
    const i = tareasSinModelo.indexOf('conversacion_respaldo');
    if (i >= 0) tareasSinModelo.splice(i, 1);
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
    medicacion: { segundoAvisoMin: e.MEDICACION_SEGUNDO_AVISO_MIN, sinRespuestaMin: e.MEDICACION_SIN_RESPUESTA_MIN, vencimientoMin: 60 },
    planificador: e.PLANIFICADOR === 'si',
    companero: { maxRondasAvatarDia: e.AVATAR_RONDAS_POR_DIA },
    avatarAnimado:
      e.AVATAR_ANIMADO === 'lemonslice' && e.LEMONSLICE_API_KEY && e.LIVEKIT_URL_PUBLICA
        ? { proveedor: 'lemonslice', apiKey: e.LEMONSLICE_API_KEY, maxMinutosDia: e.AVATAR_ANIMADO_MAX_MINUTOS_DIA, inactividadS: e.AVATAR_ANIMADO_INACTIVIDAD_S }
        : null,
    tiempoReal:
      e.LIVEKIT_URL_PUBLICA && e.LIVEKIT_URL && e.LIVEKIT_API_KEY && e.LIVEKIT_API_SECRET
        ? {
            urlPublica: e.LIVEKIT_URL_PUBLICA.replace(/\/+$/, ''),
            urlInterna: e.LIVEKIT_URL.replace(/\/+$/, ''),
            apiKey: e.LIVEKIT_API_KEY,
            apiSecret: e.LIVEKIT_API_SECRET,
            agente: e.LIVEKIT_AGENTE,
            modeloStt: e.ELEVENLABS_MODELO_STT_TIEMPO_REAL,
            finTurno: { minS: e.TIEMPO_REAL_FIN_TURNO_MIN_S, maxS: Math.max(e.TIEMPO_REAL_FIN_TURNO_MAX_S, e.TIEMPO_REAL_FIN_TURNO_MIN_S) },
            puertoAgente: e.TIEMPO_REAL_PUERTO_AGENTE,
          }
        : null,
    escalamiento: {
      twilio: e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && e.TWILIO_ORIGEN ? { accountSid: e.TWILIO_ACCOUNT_SID, authToken: e.TWILIO_AUTH_TOKEN, origen: e.TWILIO_ORIGEN } : null,
      urlPublica: e.BASE_URL_PUBLICA?.replace(/\/+$/, '') ?? null,
      voz: { idioma: e.TWILIO_IDIOMA, ...(e.TWILIO_VOZ ? { voz: e.TWILIO_VOZ } : {}) },
      emergenciaSinRespuestaMin: e.ESCALAMIENTO_EMERGENCIA_SIN_RESPUESTA_MIN,
    },
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
export function cargarConfigVoz(entornoOriginal: NodeJS.ProcessEnv = process.env): { voz: Config['voz']; emergencia: ContactosEmergencia } {
  const entorno = sinVacias(entornoOriginal);
  const e = esquemaEntornoVoz.parse(entorno);
  const protocolo = esquemaProtocolo.parse(JSON.parse(readFileSync(e.PROTOCOLO_EMERGENCIA, 'utf8')));
  return { voz: configVozDe(e), emergencia: { samu: protocolo.numeros.samu.numero, prevencionSuicidio: protocolo.numeros.prevencionSuicidio.numero } };
}
