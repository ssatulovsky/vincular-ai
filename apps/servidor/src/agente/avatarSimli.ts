/**
 * Avatar de Simli para el agente en Node. LiveKit publica el plugin de Simli solo para Python;
 * esto replica su mismo flujo (livekit-plugins-simli 1.8, avatar.py), que es corto:
 *   1. permiso de LiveKit para el participante del avatar, que publica "en nombre" del agente;
 *   2. POST /compose/token con la cara y los topes de la sesión;
 *   3. POST /integrations/livekit/agents: Simli entra a la sala;
 *   4. la voz del agente se envía al avatar (PCM 16 kHz por el canal estándar de LiveKit), y el
 *      avatar publica la cara y la voz sincronizadas.
 * A diferencia del plugin de Python, un rechazo de Simli lanza error (no se traga): así quien
 * llama vuelve a la voz directa.
 */
import { getJobContext, voice } from '@livekit/agents';
import { TrackKind, type Room } from '@livekit/rtc-node';
import { AccessToken } from 'livekit-server-sdk';
import { tokenSesionSimli, unirSimliASala, type AccesoSimli, type OpcionesSesionSimli } from '../companero/simli.ts';

const PUBLICA_EN_NOMBRE_DE = 'lk.publish_on_behalf';
const FRECUENCIA_SIMLI = 16_000;

export class AvatarSimli extends voice.AvatarSession {
  constructor(
    private readonly acceso: AccesoSimli,
    private readonly sesionSimli: OpcionesSesionSimli,
    private readonly livekit: { url: string; apiKey: string; apiSecret: string },
    private readonly identidad: string,
  ) {
    super();
  }

  override get avatarIdentity(): string {
    return this.identidad;
  }
  override get provider(): string {
    return 'simli';
  }

  override async start(sesion: voice.AgentSession, sala: Room): Promise<void> {
    await super.start(sesion, sala);
    const agente = getJobContext(false)?.agent?.identity || sala.localParticipant?.identity;
    if (!agente) throw new Error('Simli: no se conoce la identidad del agente en la sala');
    if (!sala.name) throw new Error('Simli: la sala no tiene nombre');

    const permiso = new AccessToken(this.livekit.apiKey, this.livekit.apiSecret, { identity: this.identidad, name: 'avatar', ttl: '2h' });
    permiso.kind = 'agent';
    permiso.addGrant({ roomJoin: true, room: sala.name });
    permiso.attributes = { [PUBLICA_EN_NOMBRE_DE]: agente };

    const sessionToken = await tokenSesionSimli(this.acceso, this.sesionSimli);
    await unirSimliASala(this.acceso, { sessionToken, livekitToken: await permiso.toJwt(), livekitUrl: this.livekit.url });

    // La voz espera a que el avatar publique su video: lo que se enviara antes se perdería.
    sesion.output.audio = new voice.DataStreamAudioOutput({
      room: sala,
      destinationIdentity: this.identidad,
      sampleRate: FRECUENCIA_SIMLI,
      waitRemoteTrack: TrackKind.KIND_VIDEO,
    });
  }
}
