import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { transaccion } from '../../db/conexion.ts';
import { esquemaPlan, guardarPlan, planVigente } from '../../conversacion/plan.ts';
import { turnosDeSesion } from '../../conversacion/repositorio.ts';
import { auditar } from '../../seguridad/auditoria.ts';
import { exigirPermiso } from '../../seguridad/permisos.ts';
import { ErrorHttp, exigirActor, type Aplicacion } from '../servidor.ts';
import { acusarPorEvento } from '../../escalamiento/motor.ts';

const uuid = z.string().uuid();

/** Panel clínico: plan terapéutico, bandeja de alertas y acceso excepcional a transcripciones. */
export const rutasClinicas =
  (app: Aplicacion): FastifyPluginAsync =>
  async (f) => {
    f.get('/api/personas/:id/plan-terapeutico', async (req) => {
      const actor = exigirActor(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'plan.leer', id);
      const plan = await planVigente(app.bd, app.cifrador, id);
      await auditar(app.bd, actor, { accion: 'plan.leer', recursoTipo: 'plan_terapeutico', recursoId: plan ? String(plan.version) : null, personaId: id });
      return { plan };
    });

    f.put('/api/personas/:id/plan-terapeutico', async (req) => {
      const actor = exigirActor(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'plan.editar', id);
      const b = z.object({ contenido: esquemaPlan, motivo: z.string().trim().min(5).max(500), versionBase: z.number().int().positive().nullable() }).parse(req.body);
      const version = await transaccion(app.bd, async (c) => {
        const v = await guardarPlan(c, app.cifrador, { personaId: id, contenido: b.contenido, autorId: actor.id, motivo: b.motivo, versionBase: b.versionBase });
        await auditar(c, actor, { accion: 'plan.editar', recursoTipo: 'plan_terapeutico', recursoId: String(v), personaId: id, motivo: b.motivo });
        return v;
      });
      return { version };
    });

    /**
     * Bandeja de alertas de nivel 2 y 3. La guardia ve todas; el resto, las de sus personas
     * asignadas. El fragmento literal no se incluye: se abre en el detalle, con auditoría.
     */
    f.get('/api/alertas', async (req) => {
      const actor = exigirActor(req);
      if (actor.tipo !== 'personal') throw new ErrorHttp(403, 'No tiene permiso para esta acción');
      const q = z.object({ pendientes: z.enum(['true', 'false']).default('true') }).parse(req.query);
      // El administrador no tiene asignaciones, así que no ve alertas.
      const verTodas = actor.rol === 'guardia';
      const r = await app.bd.query(
        `SELECT e.id, e.persona_id, e.sesion_id, e.nivel, e.fuente, e.categorias, e.accion, e.creado_en, e.acusado_en, e.acusado_por
           FROM evento_riesgo e
          WHERE e.nivel >= 2
            AND ($1 OR EXISTS (SELECT 1 FROM asignacion_personal a WHERE a.persona_id = e.persona_id AND a.cuenta_id = $2))
            AND ($3 = false OR e.acusado_en IS NULL)
          ORDER BY e.nivel DESC, e.creado_en DESC
          LIMIT 200`,
        [verTodas, actor.id, q.pendientes === 'true'],
      );
      return { alertas: r.rows };
    });

    f.get('/api/alertas/:id', async (req) => {
      const actor = exigirActor(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      const r = await app.bd.query<{ persona_id: string; fragmento_cifrado: Buffer; detalle: unknown; nivel: number; categorias: string[]; creado_en: Date; acusado_en: Date | null }>(
        'SELECT persona_id, fragmento_cifrado, detalle, nivel, categorias, creado_en, acusado_en FROM evento_riesgo WHERE id = $1',
        [id],
      );
      const e = r.rows[0];
      if (!e) throw new ErrorHttp(404, 'Alerta inexistente');
      await exigirPermiso(app.bd, actor, 'alertas.leer', e.persona_id);
      await auditar(app.bd, actor, { accion: 'alerta.ver_fragmento', recursoTipo: 'evento_riesgo', recursoId: id, personaId: e.persona_id });
      return { id, personaId: e.persona_id, nivel: e.nivel, categorias: e.categorias, creadoEn: e.creado_en, acusadoEn: e.acusado_en, detalle: e.detalle, fragmento: app.cifrador.descifrar(e.fragmento_cifrado) };
    });

    f.post('/api/alertas/:id/acuse', async (req) => {
      const actor = exigirActor(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      return transaccion(app.bd, async (c) => {
        const r = await c.query<{ persona_id: string; acusado_en: Date | null }>('SELECT persona_id, acusado_en FROM evento_riesgo WHERE id = $1 FOR UPDATE', [id]);
        const e = r.rows[0];
        if (!e) throw new ErrorHttp(404, 'Alerta inexistente');
        await exigirPermiso(c, actor, 'alertas.acusar', e.persona_id);
        if (e.acusado_en) throw new ErrorHttp(409, 'La alerta ya tiene acuse de recibo');
        const u = await c.query<{ acusado_en: Date }>('UPDATE evento_riesgo SET acusado_por = $2, acusado_en = now() WHERE id = $1 RETURNING acusado_en', [id, actor.id]);
        await auditar(c, actor, { accion: 'alerta.acuse', recursoTipo: 'evento_riesgo', recursoId: id, personaId: e.persona_id });
        return { acusadoEn: u.rows[0]!.acusado_en };
      }).then(async (r) => {
        // Acusar la alerta detiene su cadena de escalamiento.
        await acusarPorEvento(app.bd, id, actor.id, new Date());
        return r;
      });
    });

    /** La transcripción completa solo se abre por un motivo clínico registrado. */
    f.get('/api/personas/:id/sesiones/:sesionId/transcripcion', async (req) => {
      const actor = exigirActor(req);
      const { id, sesionId } = z.object({ id: uuid, sesionId: uuid }).parse(req.params);
      const { motivo } = z.object({ motivo: z.string().trim().min(10, 'Indique el motivo clínico (al menos 10 caracteres)').max(500) }).parse(req.query);
      await exigirPermiso(app.bd, actor, 'transcripcion.leer', id);
      const s = await app.bd.query('SELECT 1 FROM sesion_conversacion WHERE id = $1 AND persona_id = $2', [sesionId, id]);
      if (!s.rowCount) throw new ErrorHttp(404, 'Sesión inexistente');
      await auditar(app.bd, actor, { accion: 'transcripcion.leer', recursoTipo: 'sesion_conversacion', recursoId: sesionId, personaId: id, motivo });
      const turnos = await turnosDeSesion(app.bd, app.cifrador, sesionId, 10_000);
      return { turnos: turnos.map((t) => ({ hablante: t.hablante, texto: t.texto, origen: t.origen, creadoEn: t.creadoEn })) };
    });
  };
