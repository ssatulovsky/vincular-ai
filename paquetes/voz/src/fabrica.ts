import { z } from 'zod';
import { AutenticadorGoogle, leerCuentaServicio, type CredencialGoogle } from './googleAuth.ts';
import { ReconocedorElevenLabs, SintetizadorElevenLabs } from './proveedores/elevenlabs.ts';
import { ReconocedorGoogle, SintetizadorGoogle } from './proveedores/google.ts';
import type { ProveedorVoz, Reconocedor, Sintetizador, VozConfigurada } from './tipos.ts';

export const esquemaVoz = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,40}$/),
  proveedor: z.enum(['google', 'elevenlabs']),
  motor: z.string().min(2),
  voz: z.string().min(2),
  idioma: z.string().min(2),
  estilo: z.string().max(500).optional(),
  nombre: z.string().min(1).max(40),
  descripcion: z.string().max(300).optional(),
  genero: z.enum(['femenina', 'masculina']).optional(),
  grave: z.boolean().optional(),
});

export const esquemaCatalogoVoces = z.object({
  descripcion: z.string().optional(),
  /** Voces que se ofrecen a la persona en el onboarding (ids del catálogo). */
  ofrecidas: z.array(z.string()).default([]),
  porDefecto: z.string(),
  voces: z.array(esquemaVoz).min(1),
});

export type CatalogoVoces = z.infer<typeof esquemaCatalogoVoces>;

export function validarCatalogo(datos: unknown): CatalogoVoces {
  const c = esquemaCatalogoVoces.parse(datos);
  const ids = new Set(c.voces.map((v) => v.id));
  if (ids.size !== c.voces.length) throw new Error('Hay ids de voz repetidos en el catálogo');
  for (const id of [...c.ofrecidas, c.porDefecto]) if (!ids.has(id)) throw new Error(`La voz "${id}" no está en el catálogo`);
  return c;
}

export function vozDelCatalogo(c: CatalogoVoces, id: string | null | undefined): VozConfigurada {
  const v = c.voces.find((x) => x.id === id) ?? c.voces.find((x) => x.id === c.porDefecto)!;
  return v as VozConfigurada;
}

export interface ConfigVoz {
  google?: { cuentaServicio?: string; claveApi?: string; proyecto?: string; modeloGemini?: string; regionStt?: string; modeloStt?: string };
  elevenlabs?: { apiKey?: string; modeloStt?: string };
  reconocimiento: { proveedor: ProveedorVoz; idioma: string };
  timeoutMs?: number;
  /** Solo para pruebas y proxies: URLs base distintas de las oficiales. */
  urls?: { googleTts?: string; googleStt?: string; elevenlabs?: string };
}

/** Sintetizadores y reconocedor según la configuración. Lanza si falta la credencial pedida. */
export class ServiciosVoz {
  private readonly sintetizadores = new Map<ProveedorVoz, Sintetizador>();
  private reconocedorCache: Reconocedor | null = null;
  private authGoogle: AutenticadorGoogle | null = null;

  constructor(readonly config: ConfigVoz) {}

  private google(): AutenticadorGoogle {
    if (this.authGoogle) return this.authGoogle;
    const g = this.config.google;
    let cred: CredencialGoogle;
    if (g?.cuentaServicio) cred = { tipo: 'cuenta_servicio', cuenta: leerCuentaServicio(g.cuentaServicio) };
    else if (g?.claveApi) cred = { tipo: 'clave_api', clave: g.claveApi, ...(g.proyecto ? { proyecto: g.proyecto } : {}) };
    else throw new Error('Falta la credencial de Google (VOZ_GOOGLE_CUENTA_SERVICIO o VOZ_GOOGLE_CLAVE_API)');
    this.authGoogle = new AutenticadorGoogle(cred);
    return this.authGoogle;
  }

  private claveElevenLabs(): string {
    const k = this.config.elevenlabs?.apiKey;
    if (!k) throw new Error('Falta la clave de ElevenLabs (ELEVENLABS_API_KEY)');
    return k;
  }

  sintetizador(proveedor: ProveedorVoz): Sintetizador {
    const previo = this.sintetizadores.get(proveedor);
    if (previo) return previo;
    const timeoutMs = this.config.timeoutMs ?? 20_000;
    const s =
      proveedor === 'google'
        ? new SintetizadorGoogle(this.google(), { timeoutMs, ...(this.config.google?.modeloGemini ? { modeloGemini: this.config.google.modeloGemini } : {}), ...(this.config.urls?.googleTts ? { url: this.config.urls.googleTts } : {}) })
        : new SintetizadorElevenLabs({ apiKey: this.claveElevenLabs(), timeoutMs, ...(this.config.urls?.elevenlabs ? { url: this.config.urls.elevenlabs } : {}) });
    this.sintetizadores.set(proveedor, s);
    return s;
  }

  reconocedor(): Reconocedor {
    if (this.reconocedorCache) return this.reconocedorCache;
    const timeoutMs = this.config.timeoutMs ?? 30_000;
    const g = this.config.google;
    this.reconocedorCache =
      this.config.reconocimiento.proveedor === 'google'
        ? new ReconocedorGoogle(this.google(), { timeoutMs, ...(g?.regionStt ? { region: g.regionStt } : {}), ...(g?.modeloStt ? { modelo: g.modeloStt } : {}), ...(this.config.urls?.googleStt ? { url: this.config.urls.googleStt } : {}) })
        : new ReconocedorElevenLabs({ apiKey: this.claveElevenLabs(), timeoutMs, ...(this.config.elevenlabs?.modeloStt ? { modelo: this.config.elevenlabs.modeloStt } : {}), ...(this.config.urls?.elevenlabs ? { url: this.config.urls.elevenlabs } : {}) });
    return this.reconocedorCache;
  }

  /** Reconocedor de un proveedor concreto, para el benchmark. */
  reconocedorDe(proveedor: ProveedorVoz, idioma: string): { reconocedor: Reconocedor; idioma: string } {
    const otro = new ServiciosVoz({ ...this.config, reconocimiento: { proveedor, idioma } });
    otro.authGoogle = this.authGoogle;
    return { reconocedor: otro.reconocedor(), idioma };
  }
}
