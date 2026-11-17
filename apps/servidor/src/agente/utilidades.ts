import type { CatalogoVoces, VozConfigurada } from '@vincular/voz';
import { ReadableStream } from 'node:stream/web';
import { vozDelCatalogo } from '@vincular/voz';

/** Prefijo de identidad que firma el servidor (ver rutas/tiempoReal.ts). */
export const PREFIJO_IDENTIDAD = 'persona-';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * La persona sale del permiso firmado por el servidor: identidad `persona-<uuid>` y el mismo uuid
 * en los atributos. Si no calzan, no se atiende (podría ser otro participante en la sala).
 */
export function personaDelParticipante(identidad: string, atributos: Record<string, string>): { personaId: string; dispositivoId: string | null } | null {
  if (!identidad.startsWith(PREFIJO_IDENTIDAD)) return null;
  const personaId = identidad.slice(PREFIJO_IDENTIDAD.length);
  if (!UUID.test(personaId) || atributos.personaId !== personaId) return null;
  const dispositivoId = atributos.dispositivoId && UUID.test(atributos.dispositivoId) ? atributos.dispositivoId : null;
  return { personaId, dispositivoId };
}

/**
 * El tiempo real usa la voz de ElevenLabs en streaming. Si la persona eligió una voz de otro
 * proveedor, se usa la voz por defecto si es de ElevenLabs, o la primera de ElevenLabs ofrecida.
 */
export function vozParaTiempoReal(catalogo: CatalogoVoces, vozId: string | null): VozConfigurada | null {
  const elegida = vozDelCatalogo(catalogo, vozId);
  if (elegida.proveedor === 'elevenlabs') return elegida;
  const porDefecto = vozDelCatalogo(catalogo, catalogo.porDefecto);
  if (porDefecto.proveedor === 'elevenlabs') return porDefecto;
  const otra = catalogo.ofrecidas.map((id) => catalogo.voces.find((v) => v.id === id)).find((v) => v?.proveedor === 'elevenlabs');
  return (otra as VozConfigurada | undefined) ?? null;
}

/** Texto del último mensaje de la persona en el historial del agente (lo que acaba de decir). */
export function ultimoMensajeDeLaPersona(items: ReadonlyArray<{ type?: string; role?: string; textContent?: string | undefined }>): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if ((it.type === undefined || it.type === 'message') && it.role === 'user') {
      const t = (it.textContent ?? '').replace(/\s+/g, ' ').trim();
      return t.length > 0 ? t.slice(0, 4000) : null;
    }
  }
  return null;
}

/** Un texto completo como flujo de un solo trozo (el guardián revisa la respuesta entera antes de hablar). */
export function flujoDeTexto(texto: string): ReadableStream<string> {
  return new ReadableStream<string>({
    start(c) {
      c.enqueue(texto);
      c.close();
    },
  });
}

/** Silencio (s) que ElevenLabs espera para cerrar el turno: su API acepta entre 0,3 y 3 s. */
export function silencioFinDeTurno(segundos: number): number {
  return Math.min(3, Math.max(0.3, Math.round(segundos * 10) / 10));
}
