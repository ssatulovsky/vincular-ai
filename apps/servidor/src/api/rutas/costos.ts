import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { costoDeSesion, costosDelMes } from '../../costos/costos.ts';
import { exigirPermiso } from '../../seguridad/permisos.ts';
import { ErrorHttp, exigirActor, type Aplicacion } from '../servidor.ts';

/** Costo de modelos por persona al mes y por conversación (backoffice). Sin contenido clínico. */
export const rutasCostos =
  (app: Aplicacion): FastifyPluginAsync =>
  async (f) => {
    f.get('/api/costos', async (req) => {
      const actor = exigirActor(req);
      await exigirPermiso(app.bd, actor, 'costos.ver', null);
      const { mes } = z.object({ mes: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Formato AAAA-MM') }).parse(req.query);
      return costosDelMes(app.bd, app.precios, mes);
    });

    f.get('/api/costos/sesiones/:id', async (req) => {
      const actor = exigirActor(req);
      await exigirPermiso(app.bd, actor, 'costos.ver', null);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const s = await app.bd.query('SELECT 1 FROM sesion_conversacion WHERE id = $1', [id]);
      if (!s.rowCount) throw new ErrorHttp(404, 'Sesión inexistente');
      return costoDeSesion(app.bd, app.precios, id);
    });
  };
