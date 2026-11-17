import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prepararParaVoz, vozDelCatalogo } from '@vincular/voz';
import { leerPerfil, PERFIL_POR_DEFECTO } from '../../conversacion/perfil.ts';
import { exigirPermiso } from '../../seguridad/permisos.ts';
import { ErrorHttp, exigirActor, type Aplicacion } from '../servidor.ts';

/** Solo se pueden elegir las voces ofrecidas en el catálogo (o ninguna, para la voz por defecto). */
export function exigirVozOfrecida(app: Aplicacion, vozId: string | null | undefined): void {
  if (vozId && !app.catalogoVoces.ofrecidas.includes(vozId)) throw new ErrorHttp(400, 'Esa voz no está entre las ofrecidas');
}

/** Voces para el onboarding: la lista ofrecida y una muestra de cada una. */
export const rutasVoz =
  (app: Aplicacion): FastifyPluginAsync =>
  async (f) => {
    const muestras = new Map<string, Buffer>();

    f.get('/api/voces', async (req) => {
      exigirActor(req);
      return {
        porDefecto: app.catalogoVoces.porDefecto,
        voces: app.catalogoVoces.ofrecidas.map((id) => {
          const v = app.catalogoVoces.voces.find((x) => x.id === id)!;
          return { id: v.id, nombre: v.nombre, descripcion: v.descripcion ?? null, genero: v.genero ?? null, edad: v.edad ?? null, grave: v.grave ?? false };
        }),
      };
    });

    /** Muestra de una voz, en el trato y la velocidad de la persona. Se guarda en memoria. */
    const muestra = async (personaId: string, id: string): Promise<Buffer> => {
      exigirVozOfrecida(app, id);
      const voz = vozDelCatalogo(app.catalogoVoces, id);
      const perfil = (await leerPerfil(app.bd, personaId)) ?? PERFIL_POR_DEFECTO;
      const clave = `${id}|${perfil.trato}|${perfil.velocidad_voz}`;
      let audio = muestras.get(clave);
      if (!audio) {
        const texto = perfil.trato === 'tu' ? `Hola, me llamo ${voz.nombre}. ¿Te gusta cómo suena mi voz?` : `Hola, me llamo ${voz.nombre}. ¿Le gusta cómo suena mi voz?`;
        try {
          audio = (await app.voz.sintetizador(voz.proveedor).sintetizar({ texto: prepararParaVoz(texto), voz, velocidad: perfil.velocidad_voz })).audio;
        } catch {
          throw new ErrorHttp(503, 'La voz no está disponible en este momento');
        }
        muestras.set(clave, audio);
      }
      return audio;
    };

    f.get('/api/voces/:id/muestra', async (req, reply) => {
      const actor = exigirActor(req);
      if (actor.tipo !== 'dispositivo') throw new ErrorHttp(403, 'Solo desde la tablet de la persona');
      await exigirPermiso(app.bd, actor, 'perfil_companero.editar', actor.personaId);
      const { id } = z.object({ id: z.string() }).parse(req.params);
      return reply.type('audio/mpeg').header('cache-control', 'private, max-age=3600').send(await muestra(actor.personaId, id));
    });

    /** La misma muestra para el profesional que diseña el compañero desde el panel. */
    f.get('/api/personas/:persona/voces/:id/muestra', async (req, reply) => {
      const actor = exigirActor(req);
      const { persona, id } = z.object({ persona: z.string().uuid(), id: z.string() }).parse(req.params);
      if (actor.tipo !== 'personal') throw new ErrorHttp(403, 'Solo para el equipo');
      await exigirPermiso(app.bd, actor, 'perfil_companero.editar', persona);
      return reply.type('audio/mpeg').header('cache-control', 'private, max-age=3600').send(await muestra(persona, id));
    });
  };
