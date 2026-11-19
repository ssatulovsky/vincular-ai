import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { resumenBienestar } from '../../familia/resumen.ts';
import { auditar } from '../../seguridad/auditoria.ts';
import { contextoDe, exigirPermiso, type Actor } from '../../seguridad/permisos.ts';
import { ErrorHttp, exigirActor, type Aplicacion } from '../servidor.ts';

const uuid = z.string().uuid();

function exigirFamiliar(actor: Actor): Extract<Actor, { tipo: 'familiar' }> {
  if (actor.tipo !== 'familiar') throw new ErrorHttp(403, 'Solo para familiares autorizados');
  return actor;
}

/**
 * Panel familiar. La familia ve solo lo que la persona autorizó para ese contacto, nunca
 * transcripciones ni temas privados. Sus propuestas las revisa el equipo clínico.
 */
export const rutasFamilia =
  (app: Aplicacion): FastifyPluginAsync =>
  async (f) => {
    f.get('/api/familia/resumen', async (req) => {
      const actor = exigirFamiliar(exigirActor(req));
      const ctx = await contextoDe(app.bd, actor, actor.personaId);
      // Un contacto dado de baja ya no tiene sesión; esto cubre cualquier carrera.
      if (!ctx.esSuContacto) throw new ErrorHttp(403, 'Este acceso ya no está vigente');
      const r = await resumenBienestar(app.bd, app.cifrador, actor.personaId, actor.contactoId, ctx.permisosContacto);
      await auditar(app.bd, actor, { accion: 'familia.resumen', recursoTipo: 'persona', recursoId: actor.personaId, personaId: actor.personaId });
      // Los números de emergencia vienen de la configuración verificada, nunca escritos en la página.
      return { ...r, familiar: actor.nombre, emergencia: { samu: app.config.emergencia.samu, prevencionSuicidio: app.config.emergencia.prevencionSuicidio } };
    });

    f.get('/api/familia/propuestas', async (req) => {
      const actor = exigirFamiliar(exigirActor(req));
      const r = await app.bd.query<{ id: string; texto_cifrado: Buffer; estado: string; respuesta_cifrada: Buffer | null; creada_en: Date; revisada_en: Date | null }>(
        'SELECT id, texto_cifrado, estado, respuesta_cifrada, creada_en, revisada_en FROM propuesta_familiar WHERE persona_id = $1 AND contacto_id = $2 ORDER BY creada_en DESC LIMIT 30',
        [actor.personaId, actor.contactoId],
      );
      return {
        propuestas: r.rows.map((x) => ({ id: x.id, texto: app.cifrador.descifrar(x.texto_cifrado), estado: x.estado, respuesta: x.respuesta_cifrada ? app.cifrador.descifrar(x.respuesta_cifrada) : null, creadaEn: x.creada_en, revisadaEn: x.revisada_en })),
      };
    });

    f.post('/api/familia/propuestas', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
      const actor = exigirFamiliar(exigirActor(req));
      const ctx = await contextoDe(app.bd, actor, actor.personaId);
      if (!ctx.esSuContacto) throw new ErrorHttp(403, 'Este acceso ya no está vigente');
      const { texto } = z.object({ texto: z.string().trim().min(5, 'Escriba su propuesta (al menos 5 caracteres)').max(500) }).parse(req.body);
      const r = await app.bd.query<{ id: string }>('INSERT INTO propuesta_familiar (persona_id, contacto_id, texto_cifrado) VALUES ($1, $2, $3) RETURNING id', [
        actor.personaId,
        actor.contactoId,
        app.cifrador.cifrar(texto),
      ]);
      await auditar(app.bd, actor, { accion: 'familia.proponer', recursoTipo: 'propuesta_familiar', recursoId: r.rows[0]!.id, personaId: actor.personaId });
      return reply.code(201).send({ id: r.rows[0]!.id });
    });

    // ── El equipo clínico revisa las propuestas ──────────────────────────────────────
    f.get('/api/personas/:id/propuestas', async (req) => {
      const actor = exigirActor(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'persona.ver_ficha', id);
      const r = await app.bd.query<{ id: string; texto_cifrado: Buffer; estado: string; respuesta_cifrada: Buffer | null; creada_en: Date; nombre_cifrado: Buffer; relacion: string; revisor: string | null }>(
        `SELECT p.id, p.texto_cifrado, p.estado, p.respuesta_cifrada, p.creada_en, k.nombre_cifrado, k.relacion, c.nombre AS revisor
           FROM propuesta_familiar p JOIN contacto k ON k.id = p.contacto_id LEFT JOIN cuenta c ON c.id = p.revisada_por
          WHERE p.persona_id = $1 ORDER BY (p.estado = 'pendiente') DESC, p.creada_en DESC LIMIT 50`,
        [id],
      );
      return {
        propuestas: r.rows.map((x) => ({
          id: x.id,
          texto: app.cifrador.descifrar(x.texto_cifrado),
          estado: x.estado,
          respuesta: x.respuesta_cifrada ? app.cifrador.descifrar(x.respuesta_cifrada) : null,
          creadaEn: x.creada_en,
          de: `${app.cifrador.descifrar(x.nombre_cifrado)} (${x.relacion})`,
          revisor: x.revisor,
        })),
      };
    });

    f.put('/api/personas/:id/propuestas/:propuestaId', async (req) => {
      const actor = exigirActor(req);
      const { id, propuestaId } = z.object({ id: uuid, propuestaId: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'persona.ver_ficha', id);
      const b = z.object({ estado: z.enum(['aceptada', 'descartada']), respuesta: z.string().trim().max(500).optional() }).parse(req.body);
      const r = await app.bd.query(
        `UPDATE propuesta_familiar SET estado = $3, respuesta_cifrada = $4, revisada_por = $5, revisada_en = now() WHERE id = $2 AND persona_id = $1 AND estado = 'pendiente'`,
        [id, propuestaId, b.estado, b.respuesta ? app.cifrador.cifrar(b.respuesta) : null, actor.tipo === 'personal' ? actor.id : null],
      );
      if (!r.rowCount) throw new ErrorHttp(404, 'Propuesta inexistente o ya revisada');
      await auditar(app.bd, actor, { accion: `propuesta.${b.estado}`, recursoTipo: 'propuesta_familiar', recursoId: propuestaId, personaId: id });
      return { ok: true };
    });
  };
