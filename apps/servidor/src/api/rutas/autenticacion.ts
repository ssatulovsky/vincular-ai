import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { cerrarSesion, ingresar } from '../../seguridad/autenticacion.ts';
import { exigirActor, tokenDe, type Aplicacion } from '../servidor.ts';

export const rutasAutenticacion =
  (app: Aplicacion): FastifyPluginAsync =>
  async (f) => {
    f.post('/api/auth/ingresar', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
      const b = z.object({ email: z.string().email().max(200), contrasena: z.string().min(1).max(200) }).parse(req.body);
      const r = await ingresar(app.bd, b.email, b.contrasena, app.config.sesionAccesoHoras, req.ip);
      if (!r.ok) return reply.code(401).send({ error: 'Correo o contraseña incorrectos, o cuenta bloqueada temporalmente' });
      return { token: r.token, expiraEn: r.expiraEn };
    });

    f.post('/api/auth/salir', async (req) => {
      const token = tokenDe(req);
      if (token) await cerrarSesion(app.bd, token);
      return { ok: true };
    });

    f.get('/api/yo', async (req) => {
      const a = exigirActor(req);
      if (a.tipo === 'dispositivo') return { tipo: 'dispositivo', personaId: a.personaId };
      if (a.tipo === 'familiar') return { tipo: 'familiar', nombre: a.nombre, personaId: a.personaId };
      return { tipo: 'personal', nombre: a.nombre, rol: a.rol };
    });
  };
