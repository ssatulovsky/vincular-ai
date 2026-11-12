import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { transaccion } from '../../db/conexion.ts';
import { esquemaPerfil, guardarPerfil } from '../../conversacion/perfil.ts';
import { exigirVozOfrecida } from './voz.ts';
import { auditar } from '../../seguridad/auditoria.ts';
import { hashContrasena } from '../../seguridad/autenticacion.ts';
import { exigirPermiso } from '../../seguridad/permisos.ts';
import { nuevoToken } from '../../seguridad/tokens.ts';
import { ErrorHttp, exigirActor, type Aplicacion } from '../servidor.ts';

const uuid = z.string().uuid();
const ROLES = ['supervisor_clinico', 'enfermera_enlace', 'gerontologo', 'guardia', 'admin_plataforma'] as const;

/** Altas del backoffice: cuentas, personas, contactos, dispositivos y asignaciones. */
export const rutasAdministracion =
  (app: Aplicacion): FastifyPluginAsync =>
  async (f) => {
    f.post('/api/cuentas', async (req, reply) => {
      const actor = exigirActor(req);
      await exigirPermiso(app.bd, actor, 'cuenta.crear', null);
      const b = z
        .discriminatedUnion('tipo', [
          z.object({ tipo: z.literal('personal'), email: z.string().email(), nombre: z.string().min(2).max(120), contrasena: z.string().min(12).max(200), rol: z.enum(ROLES), institucion: z.string().max(120).optional() }),
          z.object({ tipo: z.literal('familiar'), email: z.string().email(), nombre: z.string().min(2).max(120), contrasena: z.string().min(12).max(200), contactoId: uuid }),
        ])
        .parse(req.body);
      const hash = await hashContrasena(b.contrasena);
      const id = await transaccion(app.bd, async (c) => {
        const r = await c.query<{ id: string }>(
          `INSERT INTO cuenta (tipo, email, nombre, hash_contrasena, rol, institucion, contacto_id) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (email) DO NOTHING RETURNING id`,
          [b.tipo, b.email.toLowerCase(), b.nombre, hash, b.tipo === 'personal' ? b.rol : null, b.tipo === 'personal' ? (b.institucion ?? null) : null, b.tipo === 'familiar' ? b.contactoId : null],
        );
        if (!r.rows[0]) throw new ErrorHttp(409, 'Ya existe una cuenta con ese correo');
        await auditar(c, actor, { accion: 'cuenta.crear', recursoTipo: 'cuenta', recursoId: r.rows[0].id, detalle: { tipo: b.tipo, rol: b.tipo === 'personal' ? b.rol : null } });
        return r.rows[0].id;
      });
      return reply.code(201).send({ id });
    });

    f.post('/api/personas', async (req, reply) => {
      const actor = exigirActor(req);
      await exigirPermiso(app.bd, actor, 'persona.crear', null);
      const b = z.object({ nombre: z.string().trim().min(2).max(120), comuna: z.string().trim().min(2).max(80), fechaNacimiento: z.string().date().optional() }).parse(req.body);
      const id = await transaccion(app.bd, async (c) => {
        const r = await c.query<{ id: string }>('INSERT INTO persona (nombre_cifrado, comuna, fecha_nacimiento) VALUES ($1, $2, $3) RETURNING id', [
          app.cifrador.cifrar(b.nombre),
          b.comuna,
          b.fechaNacimiento ?? null,
        ]);
        await auditar(c, actor, { accion: 'persona.crear', recursoTipo: 'persona', recursoId: r.rows[0]!.id, personaId: r.rows[0]!.id });
        return r.rows[0]!.id;
      });
      return reply.code(201).send({ id });
    });

    f.post('/api/personas/:id/contactos', async (req, reply) => {
      const actor = exigirActor(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'persona.crear', null);
      const b = z
        .object({
          nombre: z.string().trim().min(2).max(120),
          relacion: z.string().trim().min(2).max(60),
          telefono: z.string().trim().max(30).optional(),
          esCuidador: z.boolean().default(false),
          prioridadEmergencia: z.number().int().min(1).max(10).optional(),
          // La persona decide qué ve cada contacto; por defecto, nada.
          permisos: z.object({ resumen_bienestar: z.boolean().default(false) }).default({ resumen_bienestar: false }),
        })
        .parse(req.body);
      const contactoId = await transaccion(app.bd, async (c) => {
        const r = await c.query<{ id: string }>(
          `INSERT INTO contacto (persona_id, nombre_cifrado, relacion, telefono_cifrado, es_cuidador, prioridad_emergencia, permisos) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [id, app.cifrador.cifrar(b.nombre), b.relacion, b.telefono ? app.cifrador.cifrar(b.telefono) : null, b.esCuidador, b.prioridadEmergencia ?? null, b.permisos],
        );
        await auditar(c, actor, { accion: 'contacto.crear', recursoTipo: 'contacto', recursoId: r.rows[0]!.id, personaId: id, detalle: { permisos: b.permisos } });
        return r.rows[0]!.id;
      });
      return reply.code(201).send({ id: contactoId });
    });

    /** Entrega el token del dispositivo UNA vez; en la base solo queda su hash. */
    f.post('/api/personas/:id/dispositivos', async (req, reply) => {
      const actor = exigirActor(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'dispositivo.crear', id);
      const b = z.object({ nombre: z.string().trim().min(2).max(80) }).parse(req.body);
      const { token, hash } = nuevoToken();
      const dispositivoId = await transaccion(app.bd, async (c) => {
        const r = await c.query<{ id: string }>('INSERT INTO dispositivo (persona_id, nombre, token_hash, creado_por) VALUES ($1, $2, $3, $4) RETURNING id', [
          id,
          b.nombre,
          hash,
          actor.tipo === 'personal' ? actor.id : null,
        ]);
        await auditar(c, actor, { accion: 'dispositivo.crear', recursoTipo: 'dispositivo', recursoId: r.rows[0]!.id, personaId: id });
        return r.rows[0]!.id;
      });
      return reply.code(201).send({ id: dispositivoId, token });
    });

    f.post('/api/personas/:id/asignaciones', async (req, reply) => {
      const actor = exigirActor(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'asignacion.gestionar', id);
      const b = z.object({ cuentaId: uuid }).parse(req.body);
      await transaccion(app.bd, async (c) => {
        const cu = await c.query<{ tipo: string; rol: string | null }>('SELECT tipo, rol FROM cuenta WHERE id = $1', [b.cuentaId]);
        const rol = cu.rows[0]?.rol;
        if (cu.rows[0]?.tipo !== 'personal' || rol === 'admin_plataforma' || rol === 'guardia') {
          throw new ErrorHttp(400, 'Solo se asignan profesionales clínicos (supervisor, enfermera de enlace o gerontólogo)');
        }
        await c.query('INSERT INTO asignacion_personal (cuenta_id, persona_id, asignada_por) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [
          b.cuentaId,
          id,
          actor.tipo === 'personal' ? actor.id : null,
        ]);
        await auditar(c, actor, { accion: 'asignacion.crear', recursoTipo: 'cuenta', recursoId: b.cuentaId, personaId: id });
      });
      return reply.code(201).send({ ok: true });
    });

    f.put('/api/personas/:id/perfil-companero', async (req) => {
      const actor = exigirActor(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      await exigirPermiso(app.bd, actor, 'perfil_companero.editar', id);
      const p = esquemaPerfil.parse(req.body);
      exigirVozOfrecida(app, p.voz_id);
      await transaccion(app.bd, async (c) => {
        await guardarPerfil(c, id, p);
        await auditar(c, actor, { accion: 'perfil_companero.editar', recursoTipo: 'perfil_companero', recursoId: id, personaId: id });
      });
      return { ok: true };
    });
  };
