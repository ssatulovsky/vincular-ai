import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import type { Aplicacion } from '../servidor.ts';

const HTML = readFileSync(new URL('../../../publico/tablet.html', import.meta.url), 'utf8');
const HTML_COMPANERO = readFileSync(new URL('../../../publico/companero.html', import.meta.url), 'utf8');

// Cliente de LiveKit servido desde el propio servidor (sin CDN de terceros).
// El paquete no exporta el archivo UMD: se ubica junto a su punto de entrada (dist/).
const CLIENTE_LIVEKIT = readFileSync(path.join(path.dirname(createRequire(import.meta.url).resolve('livekit-client')), 'livekit-client.umd.js'), 'utf8');

/** Política de contenido: si hay tiempo real, se permite conectar solo a ese servidor de LiveKit. */
function politica(urlLiveKit: string | null): string {
  let livekit = '';
  if (urlLiveKit) {
    const u = new URL(urlLiveKit);
    livekit = ` ${u.protocol}//${u.host} ${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
  }
  return `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self' ws: wss:${livekit}; media-src 'self' data: blob:; img-src 'self' data: blob:; frame-ancestors 'none'`;
}

/**
 * Prototipo web de la app del acompañante, para probar la voz en tablets durante el co-diseño.
 * El micrófono del navegador exige HTTPS (o localhost). La app definitiva es la de Expo en modo
 * kiosco (Sprint 9).
 */
export const rutasTablet =
  (app: Aplicacion): FastifyPluginAsync =>
  async (f) => {
    const CSP = politica(app.config.tiempoReal?.urlPublica ?? null);

    f.get('/tablet', async (_req, reply) =>
      reply
        .type('text/html; charset=utf-8')
        .header('content-security-policy', CSP)
        .header('referrer-policy', 'no-referrer')
        .header('permissions-policy', 'microphone=(self)')
        .send(HTML),
    );

    f.get('/vendor/livekit-client.js', async (_req, reply) =>
      reply.type('application/javascript; charset=utf-8').header('cache-control', 'public, max-age=86400').send(CLIENTE_LIVEKIT),
    );

    /** Diseño del compañero: desde la tablet (con su código) o desde el panel (cuenta del equipo). */
    f.get('/companero', async (_req, reply) =>
      reply
        .type('text/html; charset=utf-8')
        .header('content-security-policy', CSP)
        .header('referrer-policy', 'no-referrer')
        .header('permissions-policy', 'microphone=()')
        .send(HTML_COMPANERO),
    );
  };
