import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { abrirSesion, leerSesion } from '../../conversacion/repositorio.ts';
import { ErrorConversacion } from '../../conversacion/orquestador.ts';
import { actorDesdeToken } from '../../seguridad/autenticacion.ts';
import { auditar } from '../../seguridad/auditoria.ts';
import type { Actor } from '../../seguridad/permisos.ts';
import { ErrorHttp, exigirActor, type Aplicacion } from '../servidor.ts';

type ActorDispositivo = Extract<Actor, { tipo: 'dispositivo' }>;

function exigirDispositivo(actor: Actor | null): ActorDispositivo {
  if (!actor) throw new ErrorHttp(401, 'Debe iniciar sesión');
  if (actor.tipo !== 'dispositivo') throw new ErrorHttp(403, 'Solo la tablet de la persona puede conversar');
  return actor;
}

/**
 * Al abrir una sesión, si hay una emergencia de las últimas 24 horas sin acuse humano, la
 * sesión nueva también parte en modo emergencia: cerrar la app no la apaga.
 * TODO(clinico): confirmar la ventana de 24 horas.
 */
async function abrir(app: Aplicacion, actor: ActorDispositivo, canal: 'texto' | 'voz'): Promise<{ sesionId: string; modoEmergencia: boolean }> {
  const sesionId = await abrirSesion(app.bd, actor.personaId, actor.id, 'persona', canal);
  const pendiente = await app.bd.query<{ categorias: string[] }>(
    `SELECT categorias FROM evento_riesgo
      WHERE persona_id = $1 AND nivel = 3 AND acusado_en IS NULL AND creado_en > now() - interval '24 hours'
      ORDER BY creado_en DESC LIMIT 1`,
    [actor.personaId],
  );
  const e = pendiente.rows[0];
  if (e) {
    await app.bd.query('UPDATE sesion_conversacion SET modo_emergencia = true, categorias_emergencia = $2 WHERE id = $1', [sesionId, e.categorias]);
  }
  return { sesionId, modoEmergencia: Boolean(e) };
}

async function cerrar(app: Aplicacion, actor: ActorDispositivo, sesionId: string): Promise<{ cerrada: boolean; motivo?: string }> {
  const s = await leerSesion(app.bd, sesionId);
  if (!s || s.personaId !== actor.personaId) throw new ErrorHttp(404, 'Sesión inexistente');
  if (s.modoEmergencia) {
    // En emergencia el agente no termina la conversación.
    await auditar(app.bd, actor, { accion: 'sesion.cierre_rechazado_emergencia', recursoTipo: 'sesion_conversacion', recursoId: sesionId, personaId: actor.personaId });
    return { cerrada: false, motivo: 'emergencia_en_curso' };
  }
  await app.bd.query('UPDATE sesion_conversacion SET fin = coalesce(fin, now()) WHERE id = $1', [sesionId]);
  return { cerrada: true };
}

export const rutasConversacion =
  (app: Aplicacion): FastifyPluginAsync =>
  async (f) => {
    f.post('/api/conversacion/sesiones', async (req, reply) => {
      const actor = exigirDispositivo(exigirActor(req));
      const b = z.object({ canal: z.enum(['texto', 'voz']).default('texto') }).default({ canal: 'texto' }).parse(req.body ?? {});
      return reply.code(201).send(await abrir(app, actor, b.canal));
    });

    f.post('/api/conversacion/sesiones/:id/turnos', async (req) => {
      const actor = exigirDispositivo(exigirActor(req));
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const b = z.object({ texto: z.string().min(1).max(4000) }).parse(req.body);
      const r = await app.orquestador.procesarTurno(id, actor.personaId, b.texto);
      return { respuesta: r.respuesta, nivel: r.nivel, modoEmergencia: r.modoEmergencia, turnoId: r.turnoId };
    });

    f.post('/api/conversacion/sesiones/:id/cerrar', async (req) => {
      const actor = exigirDispositivo(exigirActor(req));
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return cerrar(app, actor, id);
    });

    /**
     * Canal de la tablet. El navegador no puede poner cabeceras en un WebSocket, así que el
     * primer mensaje autentica: {"tipo":"autenticar","token":"..."}. Después:
     *   → {"tipo":"turno","texto":"..."}      ← {"tipo":"respuesta","texto","nivel","modoEmergencia"}
     *   → {"tipo":"cerrar"}                    ← {"tipo":"cerrada"} | {"tipo":"no_cerrada","motivo"}
     * Desde el Sprint 3 este canal transporta audio.
     */
    f.get('/api/conversacion/ws', { websocket: true }, (socket) => {
      let actor: ActorDispositivo | null = null;
      let sesionId: string | null = null;
      const enviar = (m: unknown) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(m));
      const plazoAuth = setTimeout(() => socket.close(4401, 'sin autenticar'), 10_000);

      const mensaje = z.discriminatedUnion('tipo', [
        z.object({ tipo: z.literal('autenticar'), token: z.string().min(10).max(200), canal: z.enum(['texto', 'voz']).default('texto') }),
        z.object({ tipo: z.literal('turno'), texto: z.string().min(1).max(4000) }),
        z.object({ tipo: z.literal('cerrar') }),
      ]);

      socket.on('message', async (bruto: Buffer) => {
        let m: z.infer<typeof mensaje>;
        try {
          m = mensaje.parse(JSON.parse(bruto.toString('utf8')));
        } catch {
          return enviar({ tipo: 'error', error: 'Mensaje inválido' });
        }
        try {
          if (m.tipo === 'autenticar') {
            if (actor) return enviar({ tipo: 'error', error: 'Ya autenticado' });
            const a = await actorDesdeToken(app.bd, m.token);
            if (!a || a.tipo !== 'dispositivo') {
              socket.close(4401, 'token inválido');
              return;
            }
            clearTimeout(plazoAuth);
            actor = a;
            const s = await abrir(app, a, m.canal);
            sesionId = s.sesionId;
            return enviar({ tipo: 'sesion', sesionId, modoEmergencia: s.modoEmergencia });
          }
          if (!actor || !sesionId) return enviar({ tipo: 'error', error: 'Debe autenticarse primero' });
          if (m.tipo === 'turno') {
            const r = await app.orquestador.procesarTurno(sesionId, actor.personaId, m.texto);
            return enviar({ tipo: 'respuesta', texto: r.respuesta, nivel: r.nivel, modoEmergencia: r.modoEmergencia });
          }
          const c = await cerrar(app, actor, sesionId);
          if (c.cerrada) {
            enviar({ tipo: 'cerrada' });
            socket.close(1000);
          } else enviar({ tipo: 'no_cerrada', motivo: c.motivo });
        } catch (e) {
          const error = e instanceof ErrorConversacion || e instanceof ErrorHttp ? e.message : 'Error interno';
          if (!(e instanceof ErrorConversacion || e instanceof ErrorHttp)) f.log.error({ err: e }, 'error en el canal de conversación');
          enviar({ tipo: 'error', error });
        }
      });

      socket.on('close', () => clearTimeout(plazoAuth));
    });
  };
