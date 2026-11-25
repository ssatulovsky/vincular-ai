import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from 'livekit-server-sdk';
import { PREFIJO_IDENTIDAD } from '../../agente/utilidades.ts';
import { auditar } from '../../seguridad/auditoria.ts';
import { exigirPermiso } from '../../seguridad/permisos.ts';
import { ErrorHttp, exigirActor, type Aplicacion } from '../servidor.ts';
import { exigirRequisitosConversacion } from '../requisitos.ts';


/**
 * Conversación en tiempo real (LiveKit). La tablet pide una sesión; el servidor firma un permiso
 * corto para una sala nueva y pide que el agente de Vincular entre a ella. La persona queda
 * identificada en el permiso (firmado), así el agente no confía en nada que diga la tablet.
 */
export const rutasTiempoReal =
  (app: Aplicacion): FastifyPluginAsync =>
  async (f) => {
    f.get('/api/tiempo-real', async (req) => {
      exigirActor(req);
      return { disponible: app.config.tiempoReal !== null };
    });

    f.post('/api/tiempo-real/sesion', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req, reply) => {
      const actor = exigirActor(req);
      if (actor.tipo !== 'dispositivo') throw new ErrorHttp(403, 'Solo desde la tablet de la persona');
      await exigirPermiso(app.bd, actor, 'conversacion.usar', actor.personaId);
      await exigirRequisitosConversacion(app, actor);
      const tr = app.config.tiempoReal;
      if (!tr) throw new ErrorHttp(503, 'La conversación en tiempo real no está configurada en este servidor');

      const sala = `vincular-${actor.personaId.slice(0, 8)}-${randomBytes(6).toString('hex')}`;
      const at = new AccessToken(tr.apiKey, tr.apiSecret, {
        identity: `${PREFIJO_IDENTIDAD}${actor.personaId}`,
        ttl: '10m',
        attributes: { personaId: actor.personaId, dispositivoId: actor.id },
      });
      at.addGrant({ roomJoin: true, room: sala, canPublish: true, canSubscribe: true, canPublishData: true });
      at.roomConfig = new RoomConfiguration({ agents: [new RoomAgentDispatch({ agentName: tr.agente })], emptyTimeout: 60, departureTimeout: 20 });
      await auditar(app.bd, actor, { accion: 'tiempo_real.sesion', recursoTipo: 'persona', recursoId: actor.personaId, personaId: actor.personaId, detalle: { sala } });
      return reply.code(201).send({ url: tr.urlPublica, token: await at.toJwt(), sala });
    });
  };
