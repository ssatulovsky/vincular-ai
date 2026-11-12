import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { transaccion } from '../../db/conexion.ts';
import { esquemaTurno, guardarTurno } from '../../escalamiento/guardia.ts';
import { acusarEscalamiento } from '../../escalamiento/motor.ts';
import { esquemaProtocolo, guardarProtocolo, listarProtocolos } from '../../escalamiento/protocolos.ts';
import { enmascarar, normalizarTelefono } from '../../escalamiento/telefonos.ts';
import { auditar } from '../../seguridad/auditoria.ts';
import { exigirPermiso } from '../../seguridad/permisos.ts';
import { ErrorHttp, exigirActor, type Aplicacion } from '../servidor.ts';

const uuid = z.string().uuid();

/**
 * Escalamiento: protocolos y turnos de guardia (parametrizables por el administrador y el
 * supervisor clínico, con motivo en la auditoría), teléfonos del personal y seguimiento de las
 * cadenas en curso con su acuse.
 */
export const rutasEscalamiento =
  (app: Aplicacion): FastifyPluginAsync =>
  async (f) => {
    const motivo = z.string().trim().min(5).max(300);

    f.get('/api/protocolos-escalamiento', async (req) => {
      await exigirPermiso(app.bd, exigirActor(req), 'protocolo.gestionar', null);
      return { protocolos: await listarProtocolos(app.bd) };
    });

    f.post('/api/protocolos-escalamiento', async (req, reply) => {
      const actor = exigirActor(req);
      await exigirPermiso(app.bd, actor, 'protocolo.gestionar', null);
      const b = z.object({ protocolo: esquemaProtocolo, motivo }).parse(req.body);
      const id = await transaccion(app.bd, async (c) => {
        const x = (await guardarProtocolo(c, b.protocolo, actor.tipo === 'personal' ? actor.id : null))!;
        await auditar(c, actor, { accion: 'protocolo.crear', recursoTipo: 'protocolo_escalamiento', recursoId: x, motivo: b.motivo, detalle: { protocolo: b.protocolo } });
        return x;
      });
      return reply.code(201).send({ id });
    });

    f.put('/api/protocolos-escalamiento/:id', async (req) => {
      const actor = exigirActor(req);
      await exigirPermiso(app.bd, actor, 'protocolo.gestionar', null);
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({ protocolo: esquemaProtocolo, motivo }).parse(req.body);
      await transaccion(app.bd, async (c) => {
        if (!(await guardarProtocolo(c, b.protocolo, actor.tipo === 'personal' ? actor.id : null, id))) throw new ErrorHttp(404, 'Protocolo inexistente');
        await auditar(c, actor, { accion: 'protocolo.editar', recursoTipo: 'protocolo_escalamiento', recursoId: id, motivo: b.motivo, detalle: { protocolo: b.protocolo } });
      });
      return { ok: true };
    });

    f.get('/api/guardia/turnos', async (req) => {
      await exigirPermiso(app.bd, exigirActor(req), 'protocolo.gestionar', null);
      const r = await app.bd.query<Record<string, unknown> & { telefono_cifrado: Buffer | null }>(
        `SELECT id, nombre, institucion, cuenta_id AS "cuentaId", telefono_cifrado, dias, to_char(hora_desde, 'HH24:MI') AS "horaDesde", to_char(hora_hasta, 'HH24:MI') AS "horaHasta",
                vigente_desde AS "vigenteDesde", vigente_hasta AS "vigenteHasta", cubre, prioridad, activo FROM turno_guardia ORDER BY activo DESC, prioridad DESC, nombre`,
      );
      return { turnos: r.rows.map(({ telefono_cifrado, ...t }) => ({ ...t, telefono: telefono_cifrado ? enmascarar(app.cifrador.descifrar(telefono_cifrado)) : null })) };
    });

    f.post('/api/guardia/turnos', async (req, reply) => {
      const actor = exigirActor(req);
      await exigirPermiso(app.bd, actor, 'protocolo.gestionar', null);
      const b = z.object({ turno: esquemaTurno, motivo }).parse(req.body);
      const id = await transaccion(app.bd, async (c) => {
        const x = (await guardarTurno(c, app.cifrador, app.escalamiento.hashes, b.turno))!;
        await auditar(c, actor, { accion: 'guardia.crear', recursoTipo: 'turno_guardia', recursoId: x, motivo: b.motivo });
        return x;
      });
      return reply.code(201).send({ id });
    });

    f.put('/api/guardia/turnos/:id', async (req) => {
      const actor = exigirActor(req);
      await exigirPermiso(app.bd, actor, 'protocolo.gestionar', null);
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({ turno: esquemaTurno, motivo }).parse(req.body);
      await transaccion(app.bd, async (c) => {
        if (!(await guardarTurno(c, app.cifrador, app.escalamiento.hashes, b.turno, id))) throw new ErrorHttp(404, 'Turno inexistente');
        await auditar(c, actor, { accion: 'guardia.editar', recursoTipo: 'turno_guardia', recursoId: id, motivo: b.motivo });
      });
      return { ok: true };
    });

    /** Teléfono de una cuenta del personal (para recibir SMS y llamadas). */
    f.put('/api/cuentas/:id/telefono', async (req) => {
      const actor = exigirActor(req);
      await exigirPermiso(app.bd, actor, 'cuenta.crear', null);
      const { id } = z.object({ id: uuid }).parse(req.params);
      const { telefono } = z.object({ telefono: z.string().refine((t) => normalizarTelefono(t) !== null, 'Teléfono inválido (use +56…)') }).parse(req.body);
      const t = normalizarTelefono(telefono)!;
      const r = await app.bd.query('UPDATE cuenta SET telefono_cifrado = $2, telefono_hash = $3 WHERE id = $1 AND tipo = $4', [id, app.cifrador.cifrar(t), app.escalamiento.hashes.hash(t), 'personal']);
      if (!r.rowCount) throw new ErrorHttp(404, 'Cuenta inexistente');
      await auditar(app.bd, actor, { accion: 'cuenta.telefono', recursoTipo: 'cuenta', recursoId: id });
      return { telefono: enmascarar(t) };
    });

    /** Cadenas de escalamiento: la guardia ve todas; el equipo clínico, las de sus personas. */
    f.get('/api/escalamientos', async (req) => {
      const actor = exigirActor(req);
      if (actor.tipo !== 'personal' || actor.rol === 'admin_plataforma') throw new ErrorHttp(403, 'No tiene permiso para esta acción');
      const { estado } = z.object({ estado: z.enum(['en_curso', 'todos']).default('en_curso') }).parse(req.query);
      const r = await app.bd.query(
        `SELECT e.id, e.persona_id AS "personaId", e.tipo_evento AS "tipoEvento", e.nivel, e.categorias, e.estado, e.paso_actual AS "pasoActual",
                jsonb_array_length(e.pasos) AS "totalPasos", e.proximo_paso_en AS "proximoPasoEn", e.creado_en AS "creadoEn", e.acusado_en AS "acusadoEn", e.acusado_via AS "acusadoVia",
                (e.detalle->>'personaSinResponder')::boolean IS TRUE AS "personaSinResponder",
                (SELECT count(*)::int FROM notificacion n WHERE n.escalamiento_id = e.id AND n.estado IN ('enviada')) AS enviadas,
                (SELECT count(*)::int FROM notificacion n WHERE n.escalamiento_id = e.id AND n.estado = 'fallida') AS fallidas
           FROM escalamiento e
          WHERE ($1 = 'todos' OR e.estado = 'en_curso')
            AND ($2 OR EXISTS (SELECT 1 FROM asignacion_personal a WHERE a.persona_id = e.persona_id AND a.cuenta_id = $3))
          ORDER BY e.estado = 'en_curso' DESC, e.nivel DESC, e.creado_en DESC LIMIT 200`,
        [estado, actor.rol === 'guardia', actor.id],
      );
      return { escalamientos: r.rows };
    });

    f.get('/api/escalamientos/:id', async (req) => {
      const actor = exigirActor(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      const e = await app.bd.query<{ persona_id: string }>('SELECT persona_id FROM escalamiento WHERE id = $1', [id]);
      if (!e.rows[0]) throw new ErrorHttp(404, 'Escalamiento inexistente');
      await exigirPermiso(app.bd, actor, 'alertas.leer', e.rows[0].persona_id);
      const n = await app.bd.query<{ paso: number; canal: string; estado: string; estado_proveedor: string | null; error: string | null; destino_telefono_cifrado: Buffer; destinatario_contacto_id: string | null; destinatario_cuenta_id: string | null; turno_guardia_id: string | null; creada_en: Date; enviada_en: Date | null; entregada_en: Date | null }>(
        `SELECT paso, canal, estado, estado_proveedor, error, destino_telefono_cifrado, destinatario_contacto_id, destinatario_cuenta_id, turno_guardia_id, creada_en, enviada_en, entregada_en
           FROM notificacion WHERE escalamiento_id = $1 ORDER BY paso, creada_en`,
        [id],
      );
      return {
        notificaciones: n.rows.map((x) => ({
          paso: x.paso,
          canal: x.canal,
          estado: x.estado,
          estadoProveedor: x.estado_proveedor,
          error: x.error,
          destino: x.turno_guardia_id ? 'guardia' : x.destinatario_contacto_id ? 'cuidador' : x.destinatario_cuenta_id ? 'equipo' : 'telefono',
          telefono: enmascarar(app.cifrador.descifrar(x.destino_telefono_cifrado)),
          creadaEn: x.creada_en,
          enviadaEn: x.enviada_en,
          entregadaEn: x.entregada_en,
        })),
      };
    });

    f.post('/api/escalamientos/:id/acuse', async (req) => {
      const actor = exigirActor(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      const e = await app.bd.query<{ persona_id: string }>('SELECT persona_id FROM escalamiento WHERE id = $1', [id]);
      if (!e.rows[0]) throw new ErrorHttp(404, 'Escalamiento inexistente');
      await exigirPermiso(app.bd, actor, 'alertas.acusar', e.rows[0].persona_id);
      if (!(await acusarEscalamiento(app.bd, id, { via: 'panel', cuentaId: actor.id }, new Date()))) throw new ErrorHttp(409, 'El escalamiento ya no está en curso');
      await auditar(app.bd, actor, { accion: 'escalamiento.acuse_panel', recursoTipo: 'escalamiento', recursoId: id, personaId: e.rows[0].persona_id });
      return { ok: true };
    });
  };
