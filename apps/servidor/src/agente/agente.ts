/**
 * Agente de conversación en tiempo real (LiveKit Agents). Corre como un proceso aparte del
 * servidor web (`npm run agente`) y entra a la sala que el servidor creó para la tablet.
 *
 *   voz de la persona ──► detector de voz (Silero) + voz a texto en tiempo real (ElevenLabs)
 *        ──► el MISMO orquestador de Vincular (detector de riesgo, guardián, memoria, plan)
 *        ──► texto a voz en streaming (ElevenLabs, la voz que eligió la persona) ──► tablet
 *
 * El paso "de lenguaje" no es un modelo suelto: es el orquestador, así que ninguna respuesta sale
 * sin pasar por el guardián y cada turno queda registrado como en la tablet por turnos. Por eso
 * no se usa generación anticipada: el guardián revisa la respuesta completa antes de hablar.
 */
import type { ReadableStream } from 'node:stream/web';
import { AutoSubscribe, defineAgent, voice, type JobContext, type JobProcess, type llm } from '@livekit/agents';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as silero from '@livekit/agents-plugin-silero';
import { RoomEvent, type RemoteParticipant } from '@livekit/rtc-node';
import { crearAplicacion, type Aplicacion } from '../api/servidor.ts';
import { cargarConfig } from '../config/config.ts';
import { abrirSesionConEmergencia, leerSesion } from '../conversacion/repositorio.ts';
import { leerPerfil, PERFIL_POR_DEFECTO } from '../conversacion/perfil.ts';
import { procesarSesion } from '../memoria/extraccion.ts';
import { flujoDeTexto, personaDelParticipante, ultimoMensajeDeLaPersona, vozParaTiempoReal } from './utilidades.ts';

const TEMA = 'vincular';
const codificar = (m: unknown) => new TextEncoder().encode(JSON.stringify(m));

function registro(msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: 30, msg, ...extra }));
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    // Una aplicación (base, modelos, orquestador) y el detector de voz por proceso, antes del primer llamado.
    const config = cargarConfig({ ...process.env, PLANIFICADOR: 'no' });
    proc.userData.app = crearAplicacion(config);
    proc.userData.vad = await silero.VAD.load({ minSilenceDuration: 0.6 });
  },

  entry: async (ctx: JobContext) => {
    const app = ctx.proc.userData.app as Aplicacion;
    const tr = app.config.tiempoReal;
    const claveEleven = app.config.voz.servicios.elevenlabs?.apiKey;
    if (!tr || !claveEleven) {
      registro('agente.sin_configuracion', { tiempoReal: Boolean(tr), elevenlabs: Boolean(claveEleven) });
      return ctx.shutdown('sin configuración');
    }

    await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
    const participante: RemoteParticipant = await ctx.waitForParticipant();
    const quien = personaDelParticipante(participante.identity, participante.attributes);
    if (!quien) {
      registro('agente.participante_rechazado', { identidad: participante.identity.slice(0, 60) });
      return ctx.shutdown('participante no válido');
    }

    const perfil = (await leerPerfil(app.bd, quien.personaId)) ?? PERFIL_POR_DEFECTO;
    const voz = vozParaTiempoReal(app.catalogoVoces, perfil.voz_id);
    if (!voz) {
      registro('agente.sin_voz_elevenlabs');
      return ctx.shutdown('sin voz');
    }
    const { sesionId, modoEmergencia } = await abrirSesionConEmergencia(app.bd, quien.personaId, quien.dispositivoId, 'voz');
    registro('agente.sesion', { sesionId, voz: voz.id, modoEmergencia });

    const avisarTablet = (m: unknown) => ctx.room.localParticipant?.publishData(codificar(m), { reliable: true, topic: TEMA }).catch(() => undefined);
    void avisarTablet({ tipo: 'sesion', sesionId, modoEmergencia, emergencia: { samu: app.config.emergencia.samu, prevencionSuicidio: app.config.emergencia.prevencionSuicidio } });

    class Companero extends voice.Agent {
      override async llmNode(chatCtx: llm.ChatContext): Promise<ReadableStream<string> | null> {
        const texto = ultimoMensajeDeLaPersona(chatCtx.items as never);
        if (!texto) return null;
        const inicio = performance.now();
        const r = await app.orquestador.procesarTurno(sesionId, quien!.personaId, texto);
        registro('agente.turno', { orquestadorMs: Math.round(performance.now() - inicio), nivel: r.nivel, origen: r.origen });
        void avisarTablet({ tipo: 'respuesta', nivel: r.nivel, modoEmergencia: r.modoEmergencia });
        return flujoDeTexto(r.respuesta);
      }
    }

    const sesion = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      stt: new elevenlabs.STT({ apiKey: claveEleven, model: tr.modeloStt, languageCode: app.config.voz.servicios.reconocimiento.proveedor === 'elevenlabs' ? app.config.voz.servicios.reconocimiento.idioma : 'es' }),
      // Con eleven_v4_* el plugin usa la API de diálogo, que ignora la velocidad: queda la natural de la voz.
      tts: new elevenlabs.TTS({ apiKey: claveEleven, voiceId: voz.voz, model: voz.motor, language: 'es', voiceSettings: { stability: 0.5, similarity_boost: 0.75, speed: perfil.velocidad_voz } }),
      turnHandling: {
        turnDetection: 'vad',
        // Personas mayores: pausas largas sin que el turno se corte.
        endpointing: { minDelay: tr.finTurno.minS, maxDelay: tr.finTurno.maxS },
        interruption: { enabled: true, minDuration: 0.6 },
        preemptiveGeneration: { enabled: false },
      },
    });

    // La tablet puede pedir que se calle (toque en la cara).
    ctx.room.on(RoomEvent.DataReceived, (datos: Uint8Array, p?: RemoteParticipant, _tipo?: unknown, tema?: string) => {
      if (tema !== TEMA || p?.identity !== participante.identity) return;
      try {
        const m = JSON.parse(new TextDecoder().decode(datos)) as { tipo?: string };
        if (m.tipo === 'interrumpir') void sesion.interrupt();
      } catch {
        /* mensaje inválido: se ignora */
      }
    });

    ctx.addShutdownCallback(async () => {
      // Al terminar: se cierra la sesión (salvo emergencia en curso) y se extrae su memoria.
      const s = await leerSesion(app.bd, sesionId);
      if (s && !s.modoEmergencia) {
        await app.bd.query('UPDATE sesion_conversacion SET fin = coalesce(fin, now()) WHERE id = $1', [sesionId]);
        await procesarSesion({ bd: app.bd, cifrador: app.cifrador, modelos: app.modelos }, sesionId).catch((e: Error) => registro('agente.memoria_falla', { error: e.message }));
      }
      registro('agente.fin', { sesionId });
    });

    await sesion.start({ agent: new Companero({ instructions: 'Compañero de Vincular-IA (las instrucciones reales las arma el orquestador).' }), room: ctx.room });
  },
});
