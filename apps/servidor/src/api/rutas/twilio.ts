import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { acusarPorLlamada, acusarPorRespuesta, registrarEstadoProveedor } from '../../escalamiento/motor.ts';
import { firmaValida, twimlDecir, twimlRespuesta } from '../../escalamiento/twilio.ts';
import type { Aplicacion } from '../servidor.ts';

/**
 * Webhooks de Twilio: respuestas por SMS ("1" = me hago cargo), la tecla presionada en la
 * llamada y los estados de entrega. Toda petición se valida con la firma de Twilio sobre la URL
 * pública configurada; sin Twilio configurado, estas rutas no existen.
 */
export const rutasTwilio =
  (app: Aplicacion): FastifyPluginAsync =>
  async (f) => {
    const twilio = app.config.escalamiento.twilio;
    const base = app.config.escalamiento.urlPublica;
    if (!twilio || !base) return;

    f.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 16 * 1024 }, (_req, cuerpo, hecho) => {
      hecho(null, Object.fromEntries(new URLSearchParams(cuerpo as string)));
    });

    const validar = (req: FastifyRequest): Record<string, string> | null => {
      const params = (req.body ?? {}) as Record<string, string>;
      const firma = req.headers['x-twilio-signature'];
      return firmaValida(twilio.authToken, `${base}${req.url}`, params, typeof firma === 'string' ? firma : undefined) ? params : null;
    };

    f.post('/webhooks/twilio/sms', async (req, reply) => {
      const p = validar(req);
      if (!p) return reply.code(403).send();
      const r = await acusarPorRespuesta(app.escalamiento, p.From ?? '', p.Body ?? '', new Date());
      const texto = r.acusado ? 'Gracias. Quedó registrado que usted se hace cargo. Vincular-IA.' : undefined;
      return reply.type('text/xml').send(twimlRespuesta(texto));
    });

    f.post('/webhooks/twilio/llamada', async (req, reply) => {
      const p = validar(req);
      if (!p) return reply.code(403).send();
      const id = (req.query as { n?: string }).n;
      const ok = p.Digits === '1' && typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id) ? await acusarPorLlamada(app.bd, id, new Date()) : false;
      const { idioma, voz } = app.config.escalamiento.voz;
      return reply.type('text/xml').send(twimlDecir(ok ? 'Gracias. Quedó registrado que usted se hace cargo.' : 'No se registró su respuesta. Revise sus mensajes, por favor.', idioma, voz));
    });

    f.post('/webhooks/twilio/estado', async (req, reply) => {
      const p = validar(req);
      if (!p) return reply.code(403).send();
      const id = p.MessageSid ?? p.CallSid;
      const estado = p.MessageStatus ?? p.CallStatus;
      if (id && estado) await registrarEstadoProveedor(app.bd, id, estado, new Date());
      return reply.code(204).send();
    });
  };
