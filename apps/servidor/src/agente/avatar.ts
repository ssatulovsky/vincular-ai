/**
 * Avatar animado dentro del agente de tiempo real (decisión 0016).
 *
 * Con avatar, la voz del compañero ya no sale directo a la sala: va al proveedor, que la devuelve
 * junto al video de la cara hablando. Eso crea un punto de falla nuevo, así que aquí todo está
 * pensado para que la persona nunca se quede sin escuchar a su compañero:
 *  - si el avatar no logra empezar, la conversación arranca con la voz directa;
 *  - si el avatar no aparece con video en ESPERA_VIDEO_AVATAR_S, o se desconecta a mitad de la
 *    conversación, se vuelve a publicar la voz directa y la tablet regresa al retrato.
 */
import { voice } from '@livekit/agents';
import * as lemonslice from '@livekit/agents-plugin-lemonslice';
import { RoomEvent, TrackKind, TrackPublishOptions, TrackSource, type RemoteParticipant, type RemoteTrackPublication, type Room } from '@livekit/rtc-node';
import type { Aplicacion } from '../api/servidor.ts';
import {
  abrirUsoAvatar,
  cerrarUsoAvatar,
  decidirAvatar,
  ESPERA_VIDEO_AVATAR_S,
  GESTOS_AL_ESCUCHAR,
  GESTOS_AL_HABLAR,
  minutosAvatarHoy,
} from '../companero/avatarAnimado.ts';
import { leerImagenAvatar } from '../companero/avatares.ts';

/** Misma identidad siempre: la tablet la usa para saber que ese video es la cara del compañero. */
export const IDENTIDAD_AVATAR = 'vincular-avatar';

type Registro = (msg: string, extra?: Record<string, unknown>) => void;

/**
 * Enciende el avatar ANTES de `sesion.start` (así la sesión no publica su propia voz). Devuelve
 * una función de cierre, o null si la conversación sigue sin avatar.
 */
export async function encenderAvatar(e: {
  app: Aplicacion;
  room: Room;
  sesion: voice.AgentSession;
  personaId: string;
  sesionId: string;
  avatarId: string | null;
  modoEmergencia: boolean;
  registro: Registro;
}): Promise<(() => Promise<void>) | null> {
  const { app, room, sesion, registro } = e;
  const config = app.config.avatarAnimado;
  if (!config && process.env.AVATAR_ANIMADO === 'lemonslice') registro('agente.avatar_sin_configuracion', { faltan: 'LEMONSLICE_API_KEY o LIVEKIT_URL_PUBLICA' });

  const minutosHoy = config ? await minutosAvatarHoy(app.bd, e.personaId) : 0;
  const decision = decidirAvatar({ config, avatarId: e.avatarId, modoEmergencia: e.modoEmergencia, minutosHoy });
  if (!decision.usar) {
    if (decision.motivo !== 'sin_configuracion') registro('agente.avatar_omitido', { motivo: decision.motivo, minutosHoy: Math.round(minutosHoy) });
    return null;
  }
  const retrato = await leerImagenAvatar(app.bd, e.personaId, e.avatarId!);
  if (!retrato) {
    registro('agente.avatar_omitido', { motivo: 'sin_retrato' });
    return null;
  }

  const tr = app.config.tiempoReal!;
  const usoId = await abrirUsoAvatar(app.bd, e.personaId, e.sesionId, config!.proveedor);
  const avatar = new lemonslice.AvatarSession({
    agentImage: retrato.imagen,
    agentImageMimeType: retrato.mime,
    agentPrompt: GESTOS_AL_HABLAR,
    agentIdlePrompt: GESTOS_AL_ESCUCHAR,
    idleTimeout: config!.inactividadS,
    apiKey: config!.apiKey,
    avatarParticipantIdentity: IDENTIDAD_AVATAR,
    avatarParticipantName: 'avatar',
    connOptions: { maxRetry: 1, retryIntervalMs: 1000, timeoutMs: 10_000 },
  });
  try {
    // El proveedor entra a la sala desde internet: necesita la URL pública (wss://), no la interna.
    await avatar.start(sesion, room, { livekitUrl: tr.urlPublica, livekitApiKey: tr.apiKey, livekitApiSecret: tr.apiSecret });
  } catch (err) {
    const mensaje = (err as Error).message;
    registro('agente.avatar_falla_inicio', { error: mensaje.slice(0, 200) });
    await cerrarUsoAvatar(app.bd, usoId, 'error_inicio', mensaje);
    // Si alcanzó a desviar la voz al avatar, se deshace: la sesión publicará la suya.
    if (sesion.output.audio instanceof voice.DataStreamAudioOutput) sesion.output.audio = null;
    await avatar.aclose().catch(() => undefined);
    return null;
  }
  registro('agente.avatar_encendido', { proveedor: config!.proveedor, minutosHoy: Math.round(minutosHoy) });

  let activo = true;
  const volverAVozDirecta = async (motivo: 'desconectado' | 'sin_video') => {
    if (!activo) return;
    activo = false;
    clearTimeout(vigia);
    room.off(RoomEvent.ParticipantDisconnected, alSalir);
    registro('agente.avatar_caido', { motivo });
    try {
      const directa = new voice.ParticipantAudioOutput(room, {
        sampleRate: 24000,
        numChannels: 1,
        trackPublishOptions: new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
      });
      await directa.start(new AbortController().signal);
      sesion.output.audio = directa;
      // Una respuesta que quedó esperando al avatar no saldría nunca: se corta y la persona puede repetir.
      void sesion.interrupt();
    } catch (err) {
      registro('agente.avatar_sin_voz_directa', { error: (err as Error).message.slice(0, 200) });
    }
    await cerrarUsoAvatar(app.bd, usoId, motivo);
    await avatar.aclose().catch(() => undefined);
  };

  const alSalir = (p: RemoteParticipant) => {
    if (p.identity === IDENTIDAD_AVATAR) void volverAVozDirecta('desconectado');
  };
  room.on(RoomEvent.ParticipantDisconnected, alSalir);

  const tieneVideo = () => {
    const p = room.remoteParticipants.get(IDENTIDAD_AVATAR);
    return p ? [...p.trackPublications.values()].some((t: RemoteTrackPublication) => t.kind === TrackKind.KIND_VIDEO) : false;
  };
  const vigia = setTimeout(() => {
    if (activo && !tieneVideo()) void volverAVozDirecta('sin_video');
  }, ESPERA_VIDEO_AVATAR_S * 1000);

  return async () => {
    if (!activo) return;
    activo = false;
    clearTimeout(vigia);
    room.off(RoomEvent.ParticipantDisconnected, alSalir);
    await cerrarUsoAvatar(app.bd, usoId, 'fin_sesion');
  };
}
