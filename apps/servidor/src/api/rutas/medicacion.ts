import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { transaccion } from '../../db/conexion.ts';
import { agendaSinConexion, confirmarDosis, diaLocal, dosisEntre } from '../../medicacion/agenda.ts';
import { cancelarCita, citasProximas, crearCita, datosHoja, esquemaCita, hojaHtml } from '../../medicacion/citas.ts';
import { actualizarMedicamento, crearMedicamento, esquemaMedicamento, listarMedicamentos, suspenderMedicamento } from '../../medicacion/medicamentos.ts';
import { auditar } from '../../seguridad/auditoria.ts';
import { exigirPermiso, type Actor } from '../../seguridad/permisos.ts';
import { ErrorHttp, exigirActor, type Aplicacion } from '../servidor.ts';

const uuid = z.string().uuid();

function exigirTablet(actor: Actor): Extract<Actor, { tipo: 'dispositivo' }> {
  if (actor.tipo !== 'dispositivo') throw new ErrorHttp(403, 'Solo desde la tablet de la persona');
  return actor;
}

/** Enfermero digital: medicamentos y citas (equipo de salud) y la vista de la persona. */
export const rutasMedicacion =
  (app: Aplicacion): FastifyPluginAsync =>
  async (f) => {
    const autor = (a: Actor) => (a.tipo === 'personal' ? a.id : null);

    // ── Equipo de salud ──────────────────────────────────────────────────────────────

    f.get('/api/personas/:id/medicamentos', async (req) => {
      const actor = exigirActor(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'medicacion.gestionar', id);
      const { todos } = z.object({ todos: z.enum(['true', 'false']).default('false') }).parse(req.query);
      return { medicamentos: await listarMedicamentos(app.bd, app.cifrador, id, todos !== 'true') };
    });

    f.post('/api/personas/:id/medicamentos', async (req, reply) => {
      const actor = exigirActor(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'medicacion.gestionar', id);
      const d = esquemaMedicamento.parse(req.body);
      const medId = await transaccion(app.bd, async (c) => {
        const m = await crearMedicamento(c, app.cifrador, id, d, autor(actor));
        await auditar(c, actor, { accion: 'medicamento.crear', recursoTipo: 'medicamento', recursoId: m, personaId: id });
        return m;
      });
      return reply.code(201).send({ id: medId });
    });

    f.put('/api/personas/:id/medicamentos/:medId', async (req) => {
      const actor = exigirActor(req);
      const { id, medId } = z.object({ id: uuid, medId: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'medicacion.gestionar', id);
      const d = esquemaMedicamento.parse(req.body);
      await transaccion(app.bd, async (c) => {
        if (!(await actualizarMedicamento(c, app.cifrador, id, medId, d, new Date()))) throw new ErrorHttp(404, 'Medicamento inexistente o suspendido');
        await auditar(c, actor, { accion: 'medicamento.editar', recursoTipo: 'medicamento', recursoId: medId, personaId: id });
      });
      return { ok: true };
    });

    f.post('/api/personas/:id/medicamentos/:medId/suspender', async (req) => {
      const actor = exigirActor(req);
      const { id, medId } = z.object({ id: uuid, medId: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'medicacion.gestionar', id);
      const { motivo } = z.object({ motivo: z.string().trim().min(5).max(300) }).parse(req.body);
      await transaccion(app.bd, async (c) => {
        if (!(await suspenderMedicamento(c, id, medId, new Date()))) throw new ErrorHttp(404, 'Medicamento inexistente o ya suspendido');
        await auditar(c, actor, { accion: 'medicamento.suspender', recursoTipo: 'medicamento', recursoId: medId, personaId: id, motivo });
      });
      return { ok: true };
    });

    /** Adherencia: dosis y su estado en un rango (por defecto, los últimos 7 días). */
    f.get('/api/personas/:id/dosis', async (req) => {
      const actor = exigirActor(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'medicacion.gestionar', id);
      const q = z.object({ desde: z.string().datetime({ offset: true }).optional(), hasta: z.string().datetime({ offset: true }).optional() }).parse(req.query);
      const hasta = q.hasta ? new Date(q.hasta) : new Date();
      const desde = q.desde ? new Date(q.desde) : new Date(hasta.getTime() - 7 * 86_400_000);
      return { dosis: await dosisEntre(app.bd, app.cifrador, id, desde, hasta) };
    });

    f.get('/api/personas/:id/citas', async (req) => {
      const actor = exigirActor(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'medicacion.gestionar', id);
      return { citas: await citasProximas(app.bd, app.cifrador, id, new Date(Date.now() - 86_400_000), 120) };
    });

    f.post('/api/personas/:id/citas', async (req, reply) => {
      const actor = exigirActor(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'medicacion.gestionar', id);
      const d = esquemaCita.parse(req.body);
      const citaId = await transaccion(app.bd, async (c) => {
        const x = await crearCita(c, app.cifrador, id, d, autor(actor));
        await auditar(c, actor, { accion: 'cita.crear', recursoTipo: 'cita', recursoId: x, personaId: id });
        return x;
      });
      return reply.code(201).send({ id: citaId });
    });

    f.post('/api/personas/:id/citas/:citaId/cancelar', async (req) => {
      const actor = exigirActor(req);
      const { id, citaId } = z.object({ id: uuid, citaId: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'medicacion.gestionar', id);
      if (!(await cancelarCita(app.bd, id, citaId))) throw new ErrorHttp(404, 'Cita inexistente o ya cancelada');
      await auditar(app.bd, actor, { accion: 'cita.cancelar', recursoTipo: 'cita', recursoId: citaId, personaId: id });
      return { ok: true };
    });

    /** Hoja de una página para el control (HTML imprimible). */
    const hoja = async (actor: Actor, personaId: string, citaId: string) => {
      await exigirPermiso(app.bd, actor, 'hoja_control.ver', personaId);
      const ahora = new Date();
      const d = await datosHoja(app.bd, app.cifrador, personaId, citaId, ahora);
      if (!d) throw new ErrorHttp(404, 'Cita inexistente');
      await app.bd.query('UPDATE cita SET hoja_preparada_en = $2, hoja_preparada_ref = $3 WHERE id = $1', [citaId, ahora, `v1:${ahora.toISOString()}`]);
      await auditar(app.bd, actor, { accion: 'hoja_control.ver', recursoTipo: 'cita', recursoId: citaId, personaId });
      return hojaHtml(d);
    };

    f.get('/api/personas/:id/citas/:citaId/hoja', async (req, reply) => {
      const actor = exigirActor(req);
      const { id, citaId } = z.object({ id: uuid, citaId: uuid }).parse(req.params);
      return reply.type('text/html; charset=utf-8').header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'").send(await hoja(actor, id, citaId));
    });

    // ── La persona, desde su tablet ──────────────────────────────────────────────────

    f.get('/api/mi-medicacion/hoy', async (req) => {
      const a = exigirTablet(exigirActor(req));
      await exigirPermiso(app.bd, a, 'salud.propia', a.personaId);
      const { desde, hasta } = await diaLocal(app.bd, a.personaId, new Date());
      return { dosis: (await dosisEntre(app.bd, app.cifrador, a.personaId, desde, hasta)).map(({ medicamentoId: _, ...x }) => x) };
    });

    /** Recordatorios de las próximas horas para hacerlos sonar sin conexión. */
    f.get('/api/mi-medicacion/agenda', async (req) => {
      const a = exigirTablet(exigirActor(req));
      await exigirPermiso(app.bd, a, 'salud.propia', a.personaId);
      const { horas } = z.object({ horas: z.coerce.number().int().min(1).max(72).default(48) }).parse(req.query);
      return { generadaEn: new Date().toISOString(), recordatorios: await agendaSinConexion(app.bd, app.cifrador, a.personaId, new Date(), horas) };
    });

    /** "Ya me la tomé". Sin conexión, la tablet envía después la hora en que se confirmó. */
    f.post('/api/mi-medicacion/confirmar', async (req) => {
      const a = exigirTablet(exigirActor(req));
      await exigirPermiso(app.bd, a, 'salud.propia', a.personaId);
      const b = z.object({ eventoIds: z.array(uuid).max(20).optional(), tomadaEn: z.string().datetime({ offset: true }).optional(), sinConexion: z.boolean().default(false) }).parse(req.body ?? {});
      const confirmadas = await confirmarDosis(app.bd, a.personaId, {
        ...(b.eventoIds ? { eventoIds: b.eventoIds } : {}),
        ...(b.tomadaEn ? { tomadaEn: new Date(b.tomadaEn) } : {}),
        ahora: new Date(),
        origen: b.sinConexion ? 'sin_conexion' : 'pantalla',
      });
      return { confirmadas };
    });

    f.get('/api/mis-citas', async (req) => {
      const a = exigirTablet(exigirActor(req));
      await exigirPermiso(app.bd, a, 'salud.propia', a.personaId);
      return { citas: (await citasProximas(app.bd, app.cifrador, a.personaId, new Date(), 60)).map((c) => ({ id: c.id, lugar: c.lugar, profesional: c.profesional, fecha: c.fecha })) };
    });

    f.get('/api/mis-citas/:citaId/hoja', async (req, reply) => {
      const a = exigirTablet(exigirActor(req));
      const { citaId } = z.object({ citaId: uuid }).parse(req.params);
      return reply.type('text/html; charset=utf-8').header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'").send(await hoja(a, a.personaId, citaId));
    });
  };
