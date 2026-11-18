import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { transaccion } from '../../db/conexion.ts';
import { normalizarTelefono } from '../../escalamiento/telefonos.ts';
import { auditar } from '../../seguridad/auditoria.ts';
import { exigirPermiso } from '../../seguridad/permisos.ts';
import { ErrorHttp, exigirActor, type Aplicacion } from '../servidor.ts';

const uuid = z.string().uuid();
const ESTADOS = ['onboarding', 'activa', 'pausada', 'baja'] as const;
const PERMISOS_CONTACTO = z
  .object({ resumen_bienestar: z.boolean().default(false), avisos_medicacion: z.boolean().default(false), hoja_control: z.boolean().default(false) })
  .strict();

function exigirPersonal(req: Parameters<typeof exigirActor>[0]) {
  const actor = exigirActor(req);
  if (actor.tipo !== 'personal') throw new ErrorHttp(403, 'Solo para el equipo');
  return actor;
}

function edad(fecha: Date | null, hoy = new Date()): number | null {
  if (!fecha) return null;
  let e = hoy.getFullYear() - fecha.getFullYear();
  const m = hoy.getMonth() - fecha.getMonth();
  if (m < 0 || (m === 0 && hoy.getDate() < fecha.getDate())) e--;
  return e;
}

/**
 * Panel del equipo: listado y ficha de pacientes, equipo y consentimiento.
 * El administrador ve y edita datos administrativos (nunca contenido clínico); los clínicos ven
 * sus personas asignadas con indicadores clínicos; la guardia ve a todas, solo para las alertas.
 */
export const rutasPanel =
  (app: Aplicacion): FastifyPluginAsync =>
  async (f) => {
    // ── Listado ──────────────────────────────────────────────────────────────────────
    f.get('/api/personas', async (req) => {
      const actor = exigirPersonal(req);
      const todas = actor.rol === 'admin_plataforma' || actor.rol === 'guardia';
      const clinico = actor.rol !== 'admin_plataforma' && actor.rol !== 'guardia';
      const r = await app.bd.query<{
        id: string;
        nombre_cifrado: Buffer;
        comuna: string;
        estado: string;
        fecha_nacimiento: Date | null;
        consentimiento_vigente_hasta: Date | null;
        tablets: number;
        ultimo_uso_tablet: Date | null;
        profesionales: string[];
        alertas_pendientes: number;
        ultima_sesion: Date | null;
        nivel_7d: number | null;
      }>(
        `SELECT p.id, p.nombre_cifrado, p.comuna, p.estado, p.fecha_nacimiento, p.consentimiento_vigente_hasta,
                (SELECT count(*)::int FROM dispositivo d WHERE d.persona_id = p.id AND d.revocado_en IS NULL) AS tablets,
                (SELECT max(d.ultimo_uso_en) FROM dispositivo d WHERE d.persona_id = p.id) AS ultimo_uso_tablet,
                ARRAY(SELECT c.nombre FROM asignacion_personal a JOIN cuenta c ON c.id = a.cuenta_id WHERE a.persona_id = p.id ORDER BY c.nombre) AS profesionales,
                (SELECT count(*)::int FROM evento_riesgo e WHERE e.persona_id = p.id AND e.nivel >= 2 AND e.acusado_en IS NULL) AS alertas_pendientes,
                (SELECT max(s.inicio) FROM sesion_conversacion s WHERE s.persona_id = p.id) AS ultima_sesion,
                (SELECT max(s.nivel_maximo)::int FROM sesion_conversacion s WHERE s.persona_id = p.id AND s.inicio > now() - interval '7 days') AS nivel_7d
           FROM persona p
          WHERE $1 OR EXISTS (SELECT 1 FROM asignacion_personal a WHERE a.persona_id = p.id AND a.cuenta_id = $2)
          ORDER BY p.creada_en`,
        [todas, actor.id],
      );
      await auditar(app.bd, actor, { accion: 'persona.listar', recursoTipo: 'persona', recursoId: null, personaId: null, detalle: { cantidad: r.rowCount } });
      return {
        personas: r.rows.map((x) => ({
          id: x.id,
          nombre: app.cifrador.descifrar(x.nombre_cifrado),
          comuna: x.comuna,
          estado: x.estado,
          edad: edad(x.fecha_nacimiento),
          // Que haya alertas ya es información clínica: el administrador no la ve.
          ...(actor.rol !== 'admin_plataforma' ? { alertasPendientes: x.alertas_pendientes } : {}),
          // Datos administrativos: para el administrador y los clínicos asignados.
          ...(actor.rol !== 'guardia'
            ? { consentimientoVigenteHasta: x.consentimiento_vigente_hasta, tablets: x.tablets, ultimoUsoTablet: x.ultimo_uso_tablet, profesionales: x.profesionales }
            : {}),
          // Indicadores clínicos: solo para los clínicos asignados.
          ...(clinico ? { ultimaSesion: x.ultima_sesion, nivelUltimos7Dias: x.nivel_7d ?? 0 } : {}),
        })),
      };
    });

    // ── Ficha administrativa ─────────────────────────────────────────────────────────
    f.get('/api/personas/:id/ficha', async (req) => {
      const actor = exigirPersonal(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'persona.ver_datos', id);
      const p = await app.bd.query<{ nombre_cifrado: Buffer; comuna: string; estado: string; fecha_nacimiento: Date | null; consentimiento_vigente_hasta: Date | null; creada_en: Date }>(
        'SELECT nombre_cifrado, comuna, estado, fecha_nacimiento, consentimiento_vigente_hasta, creada_en FROM persona WHERE id = $1',
        [id],
      );
      const persona = p.rows[0];
      if (!persona) throw new ErrorHttp(404, 'Persona inexistente');
      const [contactos, dispositivos, equipo, consentimientos, companero] = await Promise.all([
        app.bd.query<{ id: string; nombre_cifrado: Buffer; relacion: string; telefono_cifrado: Buffer | null; es_cuidador: boolean; prioridad_emergencia: number | null; permisos: Record<string, boolean> }>(
          'SELECT id, nombre_cifrado, relacion, telefono_cifrado, es_cuidador, prioridad_emergencia, permisos FROM contacto WHERE persona_id = $1 AND dado_de_baja_en IS NULL ORDER BY prioridad_emergencia NULLS LAST, creado_en',
          [id],
        ),
        app.bd.query('SELECT id, nombre, creado_en AS "creadoEn", ultimo_uso_en AS "ultimoUsoEn", revocado_en AS "revocadoEn" FROM dispositivo WHERE persona_id = $1 ORDER BY creado_en DESC', [id]),
        app.bd.query(
          `SELECT c.id, c.nombre, c.rol, c.institucion, a.asignada_en AS "asignadaEn" FROM asignacion_personal a JOIN cuenta c ON c.id = a.cuenta_id WHERE a.persona_id = $1 ORDER BY c.nombre`,
          [id],
        ),
        app.bd.query(
          `SELECT id, tipo, version, otorgado_en AS "otorgadoEn", revocado_en AS "revocadoEn", otorgado_por AS "otorgadoPor", otorgado_por_contacto_id AS "contactoId" FROM consentimiento WHERE persona_id = $1 ORDER BY otorgado_en DESC`,
          [id],
        ),
        app.bd.query<{ nombre: string }>('SELECT nombre FROM perfil_companero WHERE persona_id = $1', [id]),
      ]);
      await auditar(app.bd, actor, { accion: 'persona.ver_datos', recursoTipo: 'persona', recursoId: id, personaId: id });
      return {
        id,
        nombre: app.cifrador.descifrar(persona.nombre_cifrado),
        comuna: persona.comuna,
        estado: persona.estado,
        fechaNacimiento: persona.fecha_nacimiento ? persona.fecha_nacimiento.toISOString().slice(0, 10) : null,
        edad: edad(persona.fecha_nacimiento),
        consentimientoVigenteHasta: persona.consentimiento_vigente_hasta ? persona.consentimiento_vigente_hasta.toISOString().slice(0, 10) : null,
        creadaEn: persona.creada_en,
        companero: companero.rows[0]?.nombre ?? null,
        contactos: contactos.rows.map((c) => ({
          id: c.id,
          nombre: app.cifrador.descifrar(c.nombre_cifrado),
          relacion: c.relacion,
          telefono: c.telefono_cifrado ? app.cifrador.descifrar(c.telefono_cifrado) : null,
          esCuidador: c.es_cuidador,
          prioridadEmergencia: c.prioridad_emergencia,
          permisos: c.permisos,
        })),
        dispositivos: dispositivos.rows,
        equipo: equipo.rows,
        consentimientos: consentimientos.rows,
      };
    });

    f.put('/api/personas/:id', async (req) => {
      const actor = exigirPersonal(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'persona.editar', id);
      const b = z
        .object({
          nombre: z.string().trim().min(2).max(120),
          comuna: z.string().trim().min(2).max(80),
          fechaNacimiento: z.string().date().nullable(),
          estado: z.enum(ESTADOS),
        })
        .parse(req.body);
      await transaccion(app.bd, async (c) => {
        const r = await c.query('UPDATE persona SET nombre_cifrado = $2, comuna = $3, fecha_nacimiento = $4, estado = $5, actualizada_en = now() WHERE id = $1', [
          id,
          app.cifrador.cifrar(b.nombre),
          b.comuna,
          b.fechaNacimiento,
          b.estado,
        ]);
        if (!r.rowCount) throw new ErrorHttp(404, 'Persona inexistente');
        await auditar(c, actor, { accion: 'persona.editar', recursoTipo: 'persona', recursoId: id, personaId: id, detalle: { estado: b.estado } });
      });
      return { ok: true };
    });

    // ── Contactos ────────────────────────────────────────────────────────────────────
    f.put('/api/personas/:id/contactos/:contactoId', async (req) => {
      const actor = exigirPersonal(req);
      const { id, contactoId } = z.object({ id: uuid, contactoId: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'persona.editar', id);
      const b = z
        .object({
          nombre: z.string().trim().min(2).max(120),
          relacion: z.string().trim().min(2).max(60),
          telefono: z.string().trim().max(30).nullable(),
          esCuidador: z.boolean(),
          prioridadEmergencia: z.number().int().min(1).max(10).nullable(),
          permisos: PERMISOS_CONTACTO,
        })
        .parse(req.body);
      const telefono = b.telefono ? normalizarTelefono(b.telefono) : null;
      if (b.telefono && !telefono) throw new ErrorHttp(400, 'Teléfono inválido (use +56…)');
      await transaccion(app.bd, async (c) => {
        const r = await c.query(
          `UPDATE contacto SET nombre_cifrado = $3, relacion = $4, telefono_cifrado = $5, telefono_hash = $6, es_cuidador = $7, prioridad_emergencia = $8, permisos = $9
            WHERE id = $2 AND persona_id = $1 AND dado_de_baja_en IS NULL`,
          [id, contactoId, app.cifrador.cifrar(b.nombre), b.relacion, telefono ? app.cifrador.cifrar(telefono) : null, telefono ? app.escalamiento.hashes.hash(telefono) : null, b.esCuidador, b.prioridadEmergencia, b.permisos],
        );
        if (!r.rowCount) throw new ErrorHttp(404, 'Contacto inexistente');
        // Los permisos los decide la persona: queda registrado quién los cambió en su nombre.
        await auditar(c, actor, { accion: 'contacto.editar', recursoTipo: 'contacto', recursoId: contactoId, personaId: id, detalle: { permisos: b.permisos } });
      });
      return { ok: true };
    });

    /**
     * Baja de un contacto. No se borra: forma parte del historial de alertas. Deja de recibir
     * avisos y su cuenta familiar (si tiene) se desactiva y pierde sus sesiones.
     */
    f.delete('/api/personas/:id/contactos/:contactoId', async (req) => {
      const actor = exigirPersonal(req);
      const { id, contactoId } = z.object({ id: uuid, contactoId: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'persona.editar', id);
      await transaccion(app.bd, async (c) => {
        const r = await c.query('UPDATE contacto SET dado_de_baja_en = now() WHERE id = $2 AND persona_id = $1 AND dado_de_baja_en IS NULL', [id, contactoId]);
        if (!r.rowCount) throw new ErrorHttp(404, 'Contacto inexistente');
        await c.query(
          `UPDATE sesion_acceso SET cerrada_en = now() WHERE cerrada_en IS NULL AND cuenta_id IN (SELECT id FROM cuenta WHERE contacto_id = $1)`,
          [contactoId],
        );
        await c.query('UPDATE cuenta SET activa = false WHERE contacto_id = $1', [contactoId]);
        await auditar(c, actor, { accion: 'contacto.baja', recursoTipo: 'contacto', recursoId: contactoId, personaId: id });
      });
      return { ok: true };
    });

    // ── Tablets y equipo ─────────────────────────────────────────────────────────────
    f.post('/api/personas/:id/dispositivos/:dispositivoId/revocar', async (req) => {
      const actor = exigirPersonal(req);
      const { id, dispositivoId } = z.object({ id: uuid, dispositivoId: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'dispositivo.crear', id);
      await transaccion(app.bd, async (c) => {
        const r = await c.query('UPDATE dispositivo SET revocado_en = now() WHERE id = $2 AND persona_id = $1 AND revocado_en IS NULL', [id, dispositivoId]);
        if (!r.rowCount) throw new ErrorHttp(404, 'Tablet inexistente o ya revocada');
        // El código se valida en cada llamada: la tablet queda fuera de inmediato.
        await auditar(c, actor, { accion: 'dispositivo.revocar', recursoTipo: 'dispositivo', recursoId: dispositivoId, personaId: id });
      });
      return { ok: true };
    });

    f.delete('/api/personas/:id/asignaciones/:cuentaId', async (req) => {
      const actor = exigirPersonal(req);
      const { id, cuentaId } = z.object({ id: uuid, cuentaId: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'asignacion.gestionar', id);
      await transaccion(app.bd, async (c) => {
        const r = await c.query('DELETE FROM asignacion_personal WHERE persona_id = $1 AND cuenta_id = $2', [id, cuentaId]);
        if (!r.rowCount) throw new ErrorHttp(404, 'Asignación inexistente');
        await auditar(c, actor, { accion: 'asignacion.eliminar', recursoTipo: 'cuenta', recursoId: cuentaId, personaId: id });
      });
      return { ok: true };
    });

    f.get('/api/cuentas', async (req) => {
      const actor = exigirPersonal(req);
      await exigirPermiso(app.bd, actor, 'cuenta.crear', null);
      const r = await app.bd.query(
        `SELECT id, nombre, email, rol, institucion, activa, creada_en AS "creadaEn",
                (SELECT count(*)::int FROM asignacion_personal a WHERE a.cuenta_id = cuenta.id) AS personas
           FROM cuenta WHERE tipo = 'personal' ORDER BY activa DESC, nombre`,
      );
      return { cuentas: r.rows };
    });

    f.put('/api/cuentas/:id/activa', async (req) => {
      const actor = exigirPersonal(req);
      await exigirPermiso(app.bd, actor, 'cuenta.crear', null);
      const { id } = z.object({ id: uuid }).parse(req.params);
      const { activa } = z.object({ activa: z.boolean() }).parse(req.body);
      if (id === actor.id && !activa) throw new ErrorHttp(400, 'No puede desactivar su propia cuenta');
      await transaccion(app.bd, async (c) => {
        const r = await c.query(`UPDATE cuenta SET activa = $2 WHERE id = $1 AND tipo = 'personal'`, [id, activa]);
        if (!r.rowCount) throw new ErrorHttp(404, 'Cuenta inexistente');
        // Desactivar cierra sus sesiones abiertas.
        if (!activa) await c.query('UPDATE sesion_acceso SET cerrada_en = now() WHERE cuenta_id = $1 AND cerrada_en IS NULL', [id]);
        await auditar(c, actor, { accion: activa ? 'cuenta.activar' : 'cuenta.desactivar', recursoTipo: 'cuenta', recursoId: id });
      });
      return { ok: true };
    });

    // ── Consentimiento ───────────────────────────────────────────────────────────────
    f.post('/api/personas/:id/consentimientos', async (req, reply) => {
      const actor = exigirPersonal(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'persona.editar', id);
      const b = z
        .object({
          tipo: z.string().trim().min(3).max(60),
          version: z.string().trim().min(1).max(20),
          otorgadoPor: z.enum(['persona', 'representante_legal']),
          contactoId: uuid.nullable().default(null),
          // La especificación pide revisarlo cada 6 meses.
          vigenteHasta: z.string().date().nullable().default(null),
        })
        .refine((b) => b.otorgadoPor === 'persona' || b.contactoId, { message: 'Indique qué contacto es el representante legal', path: ['contactoId'] })
        .parse(req.body);
      const consentimientoId = await transaccion(app.bd, async (c) => {
        if (b.contactoId) {
          const k = await c.query('SELECT 1 FROM contacto WHERE id = $1 AND persona_id = $2 AND dado_de_baja_en IS NULL', [b.contactoId, id]);
          if (!k.rowCount) throw new ErrorHttp(400, 'El representante debe ser un contacto de la persona');
        }
        const r = await c.query<{ id: string }>(
          'INSERT INTO consentimiento (persona_id, tipo, version, otorgado_por, otorgado_por_contacto_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [id, b.tipo, b.version, b.otorgadoPor, b.contactoId],
        );
        await c.query(`UPDATE persona SET consentimiento_vigente_hasta = COALESCE($2::date, (now() + interval '6 months')::date), actualizada_en = now() WHERE id = $1`, [id, b.vigenteHasta]);
        await auditar(c, actor, { accion: 'consentimiento.registrar', recursoTipo: 'consentimiento', recursoId: r.rows[0]!.id, personaId: id, detalle: { tipo: b.tipo, version: b.version, otorgadoPor: b.otorgadoPor } });
        return r.rows[0]!.id;
      });
      return reply.code(201).send({ id: consentimientoId });
    });

    f.post('/api/personas/:id/consentimientos/:consentimientoId/revocar', async (req) => {
      const actor = exigirPersonal(req);
      const { id, consentimientoId } = z.object({ id: uuid, consentimientoId: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'persona.editar', id);
      await transaccion(app.bd, async (c) => {
        const r = await c.query('UPDATE consentimiento SET revocado_en = now() WHERE id = $2 AND persona_id = $1 AND revocado_en IS NULL', [id, consentimientoId]);
        if (!r.rowCount) throw new ErrorHttp(404, 'Consentimiento inexistente o ya revocado');
        // Sin un consentimiento vigente, la fecha de vigencia se borra.
        await c.query(
          `UPDATE persona SET consentimiento_vigente_hasta = NULL, actualizada_en = now()
            WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM consentimiento WHERE persona_id = $1 AND revocado_en IS NULL)`,
          [id],
        );
        await auditar(c, actor, { accion: 'consentimiento.revocar', recursoTipo: 'consentimiento', recursoId: consentimientoId, personaId: id });
      });
      return { ok: true };
    });

    // ── Clínico: sesiones y versiones del plan ───────────────────────────────────────
    f.get('/api/personas/:id/sesiones', async (req) => {
      const actor = exigirPersonal(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'persona.ver_ficha', id);
      const r = await app.bd.query(
        `SELECT s.id, s.inicio, s.fin, s.canal, s.iniciada_por AS "iniciadaPor", s.nivel_maximo AS "nivelMaximo", s.modo_emergencia AS "modoEmergencia",
                (SELECT count(*)::int FROM turno t WHERE t.sesion_id = s.id) AS turnos,
                (SELECT i.estado_validacion FROM informe_sesion i WHERE i.sesion_id = s.id) AS informe
           FROM sesion_conversacion s WHERE s.persona_id = $1 ORDER BY s.inicio DESC LIMIT 100`,
        [id],
      );
      return { sesiones: r.rows };
    });

    f.get('/api/personas/:id/plan-terapeutico/versiones', async (req) => {
      const actor = exigirPersonal(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'plan.leer', id);
      const r = await app.bd.query(
        `SELECT p.version, p.motivo, p.creado_en AS "creadoEn", c.nombre AS autor FROM plan_terapeutico p JOIN cuenta c ON c.id = p.autor_id WHERE p.persona_id = $1 ORDER BY p.version DESC`,
        [id],
      );
      return { versiones: r.rows };
    });
  };
