import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { esquemaPerfil, guardarPerfil, leerPerfil } from '../../conversacion/perfil.ts';
import { exigirVozOfrecida } from './voz.ts';
import { borrarMemoria, confirmarHecho, corregirHecho, episodiosRecientes, exportarMemoria, listarHechos, marcarPrivado, olvidarHecho } from '../../memoria/hechos.ts';
import { auditar } from '../../seguridad/auditoria.ts';
import { exigirPermiso, type Actor } from '../../seguridad/permisos.ts';
import { ErrorHttp, exigirActor, type Aplicacion } from '../servidor.ts';

type ActorDispositivo = Extract<Actor, { tipo: 'dispositivo' }>;

function exigirPersona(actor: Actor): ActorDispositivo {
  if (actor.tipo !== 'dispositivo') throw new ErrorHttp(403, 'Solo la persona, desde su tablet, administra su memoria');
  return actor;
}

const FRASE_BORRAR_TODO = 'BORRAR TODO';

/**
 * Control de la memoria (especificación, sección 2 y 9): la persona ve, corrige, olvida, marca
 * como privado, exporta y borra lo que el compañero recuerda. El equipo clínico asignado puede
 * verla (con auditoría). El familiar nunca.
 */
export const rutasMemoria =
  (app: Aplicacion): FastifyPluginAsync =>
  async (f) => {
    const idParam = z.object({ id: z.string().uuid() });

    // ── La persona, desde su tablet ──────────────────────────────────────────────────

    f.get('/api/mi-memoria', async (req) => {
      const a = exigirPersona(exigirActor(req));
      await exigirPermiso(app.bd, a, 'memoria.propia', a.personaId);
      const [hechos, episodios] = await Promise.all([
        listarHechos(app.bd, app.cifrador, a.personaId, { incluirPrivados: true }),
        episodiosRecientes(app.bd, app.cifrador, a.personaId, 20),
      ]);
      return {
        hechos: hechos.map((h) => ({ id: h.id, capa: h.capa, contenido: h.contenido, privado: h.privado, porConfirmar: h.estado === 'por_confirmar', actualizadoEn: h.actualizadoEn })),
        conversaciones: episodios.map((e) => ({ fecha: e.fecha, resumen: e.resumen })),
      };
    });

    f.patch('/api/mi-memoria/hechos/:id', async (req) => {
      const a = exigirPersona(exigirActor(req));
      await exigirPermiso(app.bd, a, 'memoria.propia', a.personaId);
      const { id } = idParam.parse(req.params);
      const b = z
        .object({ contenido: z.string().trim().min(3).max(300).optional(), privado: z.boolean().optional(), confirmar: z.literal(true).optional() })
        .refine((x) => x.contenido !== undefined || x.privado !== undefined || x.confirmar, 'Indique qué cambiar')
        .parse(req.body);
      let ok = true;
      if (b.contenido !== undefined) ok = await corregirHecho(app.bd, app.cifrador, a.personaId, id, b.contenido);
      if (ok && b.privado !== undefined) ok = await marcarPrivado(app.bd, a.personaId, id, b.privado);
      if (ok && b.confirmar) ok = await confirmarHecho(app.bd, a.personaId, id);
      if (!ok) throw new ErrorHttp(404, 'Recuerdo inexistente');
      await auditar(app.bd, a, {
        accion: 'memoria.editar',
        recursoTipo: 'hecho_memoria',
        recursoId: id,
        personaId: a.personaId,
        detalle: { corrige: b.contenido !== undefined, privado: b.privado ?? null, confirma: Boolean(b.confirmar), via: 'pantalla' },
      });
      return { ok: true };
    });

    f.delete('/api/mi-memoria/hechos/:id', async (req) => {
      const a = exigirPersona(exigirActor(req));
      await exigirPermiso(app.bd, a, 'memoria.propia', a.personaId);
      const { id } = idParam.parse(req.params);
      if (!(await olvidarHecho(app.bd, a.personaId, id))) throw new ErrorHttp(404, 'Recuerdo inexistente');
      await auditar(app.bd, a, { accion: 'memoria.olvidar', recursoTipo: 'hecho_memoria', recursoId: id, personaId: a.personaId, detalle: { via: 'pantalla' } });
      return { ok: true };
    });

    /** Derecho de acceso y portabilidad: toda la memoria en un archivo JSON. */
    f.get('/api/mi-memoria/exportar', async (req, reply) => {
      const a = exigirPersona(exigirActor(req));
      await exigirPermiso(app.bd, a, 'memoria.propia', a.personaId);
      const datos = await exportarMemoria(app.bd, app.cifrador, a.personaId);
      await auditar(app.bd, a, { accion: 'memoria.exportar', recursoTipo: 'persona', recursoId: a.personaId, personaId: a.personaId });
      return reply.header('content-disposition', `attachment; filename="mi-memoria-${new Date().toISOString().slice(0, 10)}.json"`).send(datos);
    });

    /** Borrar toda la memoria. Exige escribir la frase de confirmación. */
    f.delete('/api/mi-memoria', async (req) => {
      const a = exigirPersona(exigirActor(req));
      await exigirPermiso(app.bd, a, 'memoria.propia', a.personaId);
      const b = z.object({ confirmacion: z.string() }).parse(req.body ?? {});
      if (b.confirmacion.trim().toUpperCase() !== FRASE_BORRAR_TODO) throw new ErrorHttp(400, `Para borrar toda la memoria escriba "${FRASE_BORRAR_TODO}"`);
      const r = await borrarMemoria(app.bd, a.personaId);
      await auditar(app.bd, a, { accion: 'memoria.borrar_todo', recursoTipo: 'persona', recursoId: a.personaId, personaId: a.personaId, detalle: r });
      return { borrados: r };
    });

    f.get('/api/mi-perfil-companero', async (req) => {
      const a = exigirPersona(exigirActor(req));
      await exigirPermiso(app.bd, a, 'perfil_companero.editar', a.personaId);
      return { perfil: await leerPerfil(app.bd, a.personaId) };
    });

    f.put('/api/mi-perfil-companero', async (req) => {
      const a = exigirPersona(exigirActor(req));
      await exigirPermiso(app.bd, a, 'perfil_companero.editar', a.personaId);
      const p = esquemaPerfil.parse(req.body);
      exigirVozOfrecida(app, p.voz_id);
      await guardarPerfil(app.bd, a.personaId, p);
      await auditar(app.bd, a, { accion: 'perfil_companero.editar', recursoTipo: 'perfil_companero', recursoId: a.personaId, personaId: a.personaId, detalle: { via: 'persona' } });
      return { ok: true };
    });

    // ── El equipo clínico asignado ───────────────────────────────────────────────────

    f.get('/api/personas/:id/memoria', async (req) => {
      const actor = exigirActor(req);
      const { id } = idParam.parse(req.params);
      await exigirPermiso(app.bd, actor, 'memoria.ver', id);
      const [hechos, episodios] = await Promise.all([listarHechos(app.bd, app.cifrador, id, { incluirPrivados: true }), episodiosRecientes(app.bd, app.cifrador, id, 20)]);
      await auditar(app.bd, actor, { accion: 'memoria.ver', recursoTipo: 'persona', recursoId: id, personaId: id });
      return {
        hechos: hechos.map((h) => ({ id: h.id, capa: h.capa, contenido: h.contenido, privado: h.privado, estado: h.estado, fuente: h.fuente, actualizadoEn: h.actualizadoEn })),
        conversaciones: episodios.map((e) => ({ fecha: e.fecha, resumen: e.resumen, temasPendientes: e.temasPendientes })),
      };
    });
  };
