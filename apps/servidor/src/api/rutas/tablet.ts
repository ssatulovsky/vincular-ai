import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import type { Aplicacion } from '../servidor.ts';

const HTML = readFileSync(new URL('../../../publico/tablet.html', import.meta.url), 'utf8');
const HTML_COMPANERO = readFileSync(new URL('../../../publico/companero.html', import.meta.url), 'utf8');
const HTML_PANEL = readFileSync(new URL('../../../publico/panel.html', import.meta.url), 'utf8');
const HTML_FAMILIA = readFileSync(new URL('../../../publico/familia.html', import.meta.url), 'utf8');

// Logo de Vincular-IA (ícono, favicon y logo completo). Lista cerrada: no se sirve otra cosa de la carpeta.
const MARCA = new Map(
  ['emblema-512.png', 'emblema-192.png', 'emblema-180.png', 'emblema-96.png', 'favicon-64.png', 'favicon-32.png', 'logo-completo.jpg'].map((n) => [
    n,
    readFileSync(new URL(`../../../publico/marca/${n}`, import.meta.url)),
  ]),
);

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

    f.get('/marca/:archivo', async (req, reply) => {
      const nombre = (req.params as { archivo: string }).archivo;
      const archivo = MARCA.get(nombre);
      if (!archivo) return reply.code(404).send({ error: 'No existe' });
      return reply.type(nombre.endsWith('.jpg') ? 'image/jpeg' : 'image/png').header('cache-control', 'public, max-age=604800').send(archivo);
    });
    // Instalar como app en el celular o la tablet ("Agregar a pantalla de inicio").
    const manifiesto = (nombre: string, corto: string, inicio: string, color: string) => ({
      name: nombre,
      short_name: corto,
      lang: 'es-CL',
      start_url: inicio,
      scope: inicio,
      display: 'standalone',
      orientation: 'any',
      background_color: '#E7EEEA',
      theme_color: color,
      icons: [
        { src: '/marca/emblema-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/marca/emblema-512.png', sizes: '512x512', type: 'image/png' },
      ],
    });
    const MANIFIESTOS: Record<string, ReturnType<typeof manifiesto>> = {
      tablet: manifiesto('Vincular-IA · Mi compañero', 'Mi compañero', '/tablet', '#1E5A47'),
      familia: manifiesto('Vincular-IA para familias', 'Vincular-IA', '/familia', '#1E5A47'),
      panel: manifiesto('Vincular-IA · Panel del equipo', 'Vincular-IA', '/panel', '#1E5A47'),
    };
    f.get('/manifest-:app.webmanifest', async (req, reply) => {
      const m = MANIFIESTOS[(req.params as { app: string }).app];
      if (!m) return reply.code(404).send({ error: 'No existe' });
      return reply.type('application/manifest+json').header('cache-control', 'public, max-age=86400').send(JSON.stringify(m));
    });

    // Los navegadores piden /favicon.ico por su cuenta.
    f.get('/favicon.ico', async (_req, reply) => reply.redirect('/marca/favicon-32.png', 301));

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

    /** Panel del equipo: pacientes, alertas, plan terapéutico y cuentas, según el rol. */
    f.get('/panel', async (_req, reply) =>
      reply
        .type('text/html; charset=utf-8')
        .header('content-security-policy', CSP)
        .header('referrer-policy', 'no-referrer')
        .header('permissions-policy', 'microphone=(), camera=()')
        .header('cache-control', 'no-store')
        .send(HTML_PANEL),
    );

    /** Página de la familia: solo lo que la persona autorizó, nunca transcripciones. */
    f.get('/familia', async (_req, reply) =>
      reply
        .type('text/html; charset=utf-8')
        .header('content-security-policy', CSP)
        .header('referrer-policy', 'no-referrer')
        .header('permissions-policy', 'microphone=(), camera=()')
        .header('cache-control', 'no-store')
        .send(HTML_FAMILIA),
    );
  };
