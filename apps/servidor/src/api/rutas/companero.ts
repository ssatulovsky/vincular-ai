import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ErrorAvatares, esquemaPedidoAvatares, generarRonda, leerImagenAvatar, listarRetratos, rondasDeHoy, type PedidoAvatares } from '../../companero/avatares.ts';
import { leerPerfil } from '../../conversacion/perfil.ts';
import { auditar } from '../../seguridad/auditoria.ts';
import { exigirPermiso, type Actor } from '../../seguridad/permisos.ts';
import { ErrorHttp, exigirActor, type Aplicacion } from '../servidor.ts';

/**
 * Diseño del compañero: retratos para elegir el avatar. Lo usa la persona desde su tablet
 * (/api/mi-companero/…) y el profesional asignado desde el panel (/api/personas/:id/companero/…),
 * con el mismo permiso que editar el perfil.
 */
export const rutasCompanero =
  (app: Aplicacion): FastifyPluginAsync =>
  async (f) => {
    const generar = async (actor: Actor, personaId: string, cuerpo: unknown) => {
      await exigirPermiso(app.bd, actor, 'perfil_companero.editar', personaId);
      const pedido: PedidoAvatares = esquemaPedidoAvatares.parse(cuerpo);
      try {
        const r = await generarRonda(
          { bd: app.bd, modelos: app.modelos, maxRondasDia: app.config.companero.maxRondasAvatarDia },
          personaId,
          pedido,
          actor.tipo === 'dispositivo' ? 'persona' : 'personal',
        );
        await auditar(app.bd, actor, { accion: 'avatar.generar', recursoTipo: 'persona', recursoId: personaId, personaId, detalle: { ronda: r.ronda, cantidad: r.ids.length, fallidas: r.fallidas, ...pedido } });
        return { ronda: r.ronda, propuestas: r.ids };
      } catch (e) {
        if (e instanceof ErrorAvatares) throw new ErrorHttp(e.estado, e.message);
        throw e;
      }
    };

    const imagen = async (actor: Actor, personaId: string, avatarId: string, reply: FastifyReply) => {
      await exigirPermiso(app.bd, actor, 'perfil_companero.editar', personaId);
      const img = await leerImagenAvatar(app.bd, personaId, avatarId);
      if (!img) throw new ErrorHttp(404, 'Ese retrato no existe');
      return reply.type(img.mime).header('cache-control', 'private, max-age=86400').send(img.imagen);
    };

    const listar = async (actor: Actor, personaId: string) => {
      await exigirPermiso(app.bd, actor, 'perfil_companero.editar', personaId);
      const usadas = await rondasDeHoy(app.bd, personaId);
      return { retratos: await listarRetratos(app.bd, personaId), rondasRestantesHoy: Math.max(0, app.config.companero.maxRondasAvatarDia - usadas) };
    };

    // ── La persona, desde su tablet ──────────────────────────────────────────────────
    const limite = { config: { rateLimit: { max: 6, timeWindow: '10 minutes' } } };

    f.post('/api/mi-companero/avatares', limite, async (req, reply) => {
      const actor = exigirActor(req);
      if (actor.tipo !== 'dispositivo') throw new ErrorHttp(403, 'Solo desde la tablet de la persona');
      return reply.code(201).send(await generar(actor, actor.personaId, req.body));
    });

    f.get('/api/mi-companero/avatares', async (req) => {
      const actor = exigirActor(req);
      if (actor.tipo !== 'dispositivo') throw new ErrorHttp(403, 'Solo desde la tablet de la persona');
      return listar(actor, actor.personaId);
    });

    f.get('/api/mi-companero/avatares/:avatar/imagen', async (req, reply) => {
      const actor = exigirActor(req);
      if (actor.tipo !== 'dispositivo') throw new ErrorHttp(403, 'Solo desde la tablet de la persona');
      const { avatar } = z.object({ avatar: z.string() }).parse(req.params);
      return imagen(actor, actor.personaId, avatar, reply);
    });

    // ── El equipo, desde el panel ────────────────────────────────────────────────────
    const personaParam = z.object({ id: z.string().uuid() });

    /** Personas que la cuenta puede atender: todas para el administrador, las asignadas para el equipo clínico. */
    f.get('/api/mis-personas', async (req) => {
      const actor = exigirActor(req);
      if (actor.tipo !== 'personal') throw new ErrorHttp(403, 'Solo para el equipo');
      const todas = actor.rol === 'admin_plataforma';
      const r = await app.bd.query<{ id: string; nombre_cifrado: Buffer; comuna: string; estado: string; companero: string | null }>(
        `SELECT p.id, p.nombre_cifrado, p.comuna, p.estado, pc.nombre AS companero
           FROM persona p LEFT JOIN perfil_companero pc ON pc.persona_id = p.id
          WHERE $1 OR EXISTS (SELECT 1 FROM asignacion_personal a WHERE a.persona_id = p.id AND a.cuenta_id = $2)
          ORDER BY p.creada_en`,
        [todas, actor.id],
      );
      await auditar(app.bd, actor, { accion: 'persona.listar', recursoTipo: 'persona', recursoId: null, personaId: null, detalle: { cantidad: r.rowCount } });
      return { personas: r.rows.map((x) => ({ id: x.id, nombre: app.cifrador.descifrar(x.nombre_cifrado), comuna: x.comuna, estado: x.estado, companero: x.companero })) };
    });

    f.get('/api/personas/:id/perfil-companero', async (req) => {
      const actor = exigirActor(req);
      if (actor.tipo !== 'personal') throw new ErrorHttp(403, 'Solo para el equipo');
      const { id } = personaParam.parse(req.params);
      await exigirPermiso(app.bd, actor, 'perfil_companero.editar', id);
      return { perfil: await leerPerfil(app.bd, id) };
    });

    f.post('/api/personas/:id/companero/avatares', limite, async (req, reply) => {
      const actor = exigirActor(req);
      if (actor.tipo !== 'personal') throw new ErrorHttp(403, 'Solo para el equipo');
      const { id } = personaParam.parse(req.params);
      return reply.code(201).send(await generar(actor, id, req.body));
    });

    f.get('/api/personas/:id/companero/avatares', async (req) => {
      const actor = exigirActor(req);
      if (actor.tipo !== 'personal') throw new ErrorHttp(403, 'Solo para el equipo');
      const { id } = personaParam.parse(req.params);
      return listar(actor, id);
    });

    f.get('/api/personas/:id/companero/avatares/:avatar/imagen', async (req, reply) => {
      const actor = exigirActor(req);
      if (actor.tipo !== 'personal') throw new ErrorHttp(403, 'Solo para el equipo');
      const { id, avatar } = z.object({ id: z.string().uuid(), avatar: z.string() }).parse(req.params);
      return imagen(actor, id, avatar, reply);
    });
  };
