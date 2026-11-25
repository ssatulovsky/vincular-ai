import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { transaccion } from '../../db/conexion.ts';
import { auditar } from '../../seguridad/auditoria.ts';
import { exigirPermiso } from '../../seguridad/permisos.ts';
import { CRITERIOS_EXCLUSION, esquemaEvaluacion, requisitosPendientes } from '../../seguridad/requisitos.ts';
import { exportarTodo } from '../../seguridad/derechos.ts';
import { TAREAS_MANUALES, verificarPreparacion } from '../../administracion/preparacion.ts';
import { ErrorHttp, exigirActor, type Aplicacion } from '../servidor.ts';

const uuid = z.string().uuid();

function exigirPersonal(req: Parameters<typeof exigirActor>[0]) {
  const actor = exigirActor(req);
  if (actor.tipo !== 'personal') throw new ErrorHttp(403, 'Solo para el equipo');
  return actor;
}

/**
 * Evaluación clínica de ingreso, requisitos para conversar y derechos sobre los datos
 * (decisión 0018).
 */
export const rutasIngreso =
  (app: Aplicacion): FastifyPluginAsync =>
  async (f) => {
    f.get('/api/criterios-exclusion', async (req) => {
      exigirPersonal(req);
      return { criterios: Object.entries(CRITERIOS_EXCLUSION).map(([clave, texto]) => ({ clave, texto })) };
    });

    // Qué le falta a la persona para conversar. Sin contenido clínico: lo ve también la administración.
    f.get('/api/personas/:id/requisitos', async (req) => {
      const actor = exigirPersonal(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'persona.ver_datos', id);
      return { faltan: await requisitosPendientes(app.bd, id) };
    });

    f.get('/api/personas/:id/evaluaciones', async (req) => {
      const actor = exigirPersonal(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'evaluacion.leer', id);
      const r = await app.bd.query<{ id: string; resultado: string; criterios: Record<string, boolean>; notas_cifradas: Buffer | null; revisar_antes_de: Date; creado_en: Date; autor: string; rol: string }>(
        `SELECT e.id, e.resultado, e.criterios, e.notas_cifradas, e.revisar_antes_de, e.creado_en, c.nombre AS autor, c.rol
           FROM evaluacion_ingreso e JOIN cuenta c ON c.id = e.autor_id WHERE e.persona_id = $1 ORDER BY e.creado_en DESC`,
        [id],
      );
      return {
        evaluaciones: r.rows.map((x) => ({
          id: x.id,
          resultado: x.resultado,
          criterios: x.criterios,
          notas: x.notas_cifradas ? app.cifrador.descifrar(x.notas_cifradas) : '',
          revisarAntesDe: x.revisar_antes_de.toISOString().slice(0, 10),
          creadoEn: x.creado_en,
          autor: x.autor,
          rol: x.rol,
        })),
      };
    });

    f.post('/api/personas/:id/evaluaciones', async (req, reply) => {
      const actor = exigirPersonal(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'evaluacion.registrar', id);
      const e = esquemaEvaluacion.parse(req.body);
      const evaluacionId = await transaccion(app.bd, async (c) => {
        const r = await c.query<{ id: string }>(
          `INSERT INTO evaluacion_ingreso (persona_id, resultado, criterios, notas_cifradas, revisar_antes_de, autor_id)
           VALUES ($1, $2, $3, $4, COALESCE($5::date, ((now() AT TIME ZONE 'America/Santiago')::date + interval '6 months')::date), $6) RETURNING id`,
          [id, e.resultado, e.criterios, e.notas ? app.cifrador.cifrar(e.notas) : null, e.revisarAntesDe, actor.id],
        );
        const presentes = Object.entries(e.criterios).filter(([, v]) => v).map(([k]) => k);
        await auditar(c, actor, { accion: 'evaluacion_ingreso.registrar', recursoTipo: 'evaluacion_ingreso', recursoId: r.rows[0]!.id, personaId: id, detalle: { resultado: e.resultado, criteriosPresentes: presentes } });
        return r.rows[0]!.id;
      });
      return reply.code(201).send({ id: evaluacionId });
    });

    // ── Preparación del piloto ───────────────────────────────────────────────────────
    f.get('/api/preparacion', async (req) => {
      const actor = exigirPersonal(req);
      await exigirPermiso(app.bd, actor, 'protocolo.gestionar', null);
      const r = await verificarPreparacion(app.bd, app.config);
      return { ...r, personas: r.personas.map(({ nombre_cifrado, ...x }) => ({ ...x, nombre: app.cifrador.descifrar(nombre_cifrado) })) };
    });

    f.put('/api/preparacion/manual/:clave', async (req) => {
      const actor = exigirPersonal(req);
      await exigirPermiso(app.bd, actor, 'protocolo.gestionar', null);
      const { clave } = z.object({ clave: z.string().refine((k) => k in TAREAS_MANUALES, 'Tarea desconocida') }).parse(req.params);
      const b = z.object({ completado: z.boolean(), nota: z.string().trim().max(500).default('') }).parse(req.body);
      await app.bd.query(
        `INSERT INTO preparacion_manual (clave, completado, nota, actualizado_por) VALUES ($1, $2, $3, $4)
         ON CONFLICT (clave) DO UPDATE SET completado = $2, nota = $3, actualizado_por = $4, actualizado_en = now()`,
        [clave, b.completado, b.nota, actor.id],
      );
      await auditar(app.bd, actor, { accion: 'preparacion.marcar', recursoTipo: 'preparacion_manual', recursoId: clave, detalle: { completado: b.completado } });
      return { ok: true };
    });

    // ── Derechos sobre los datos (Ley 21.719) ─────────────────────────────────────────
    f.post('/api/personas/:id/exportar-todo', async (req, reply) => {
      const actor = exigirPersonal(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'persona.exportar', id);
      const { motivo } = z.object({ motivo: z.string().trim().min(10, 'Indique el motivo (p. ej. "solicitud de acceso de la persona del 25-11")').max(300) }).parse(req.body);
      const datos = await exportarTodo(app.bd, app.cifrador, id);
      if (!datos) throw new ErrorHttp(404, 'Persona inexistente');
      await auditar(app.bd, actor, { accion: 'persona.exportar_todo', recursoTipo: 'persona', recursoId: id, personaId: id, motivo, detalle: { tablas: Object.keys(datos.tablas).length } });
      return reply
        .header('content-type', 'application/json; charset=utf-8')
        .header('content-disposition', `attachment; filename="vincular-datos-${id.slice(0, 8)}.json"`)
        .send(JSON.stringify(datos, null, 2));
    });

    f.post('/api/personas/:id/suprimir', async (req) => {
      const actor = exigirPersonal(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'persona.suprimir', id);
      const b = z
        .object({
          confirmacion: z.literal('SUPRIMIR', { message: 'Escriba SUPRIMIR para confirmar' }),
          motivo: z.string().trim().min(10, 'Indique el motivo (p. ej. "solicitud de supresión de la persona del 25-11")').max(300),
        })
        .parse(req.body);
      await transaccion(app.bd, async (c) => {
        // La constancia queda antes del borrado y sobrevive a él (la auditoría no depende de persona).
        await auditar(c, actor, { accion: 'persona.suprimir', recursoTipo: 'persona', recursoId: id, personaId: id, motivo: b.motivo });
        const r = await c.query('DELETE FROM persona WHERE id = $1', [id]);
        if (!r.rowCount) throw new ErrorHttp(404, 'Persona inexistente');
      });
      return { ok: true };
    });
  };
