import { readFileSync } from 'node:fs';
import type { FastifyPluginAsync } from 'fastify';
import type { Aplicacion } from '../servidor.ts';

const HTML = readFileSync(new URL('../../../publico/tablet.html', import.meta.url), 'utf8');

/**
 * Prototipo web de la app del acompañante, para probar la voz en tablets durante el co-diseño.
 * El micrófono del navegador exige HTTPS (o localhost). La app definitiva es la de Expo en modo
 * kiosco (Sprint 9).
 */
export const rutasTablet =
  (_app: Aplicacion): FastifyPluginAsync =>
  async (f) => {
    f.get('/tablet', async (_req, reply) =>
      reply
        .type('text/html; charset=utf-8')
        .header(
          'content-security-policy',
          "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self' ws: wss:; media-src 'self' data: blob:; img-src 'self' data:; frame-ancestors 'none'",
        )
        .header('referrer-policy', 'no-referrer')
        .header('permissions-policy', 'microphone=(self)')
        .send(HTML),
    );
  };
