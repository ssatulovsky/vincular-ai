import { prepararParaVoz, vozDelCatalogo, type CatalogoVoces, type ServiciosVoz } from '@vincular/voz';
import type { ContactosEmergencia } from '@vincular/seguridad-clinica';
import type { Bd } from './db/conexion.ts';
import { leerPerfil, PERFIL_POR_DEFECTO } from './conversacion/perfil.ts';
import type { EntregaTablet, Recordatorio } from './medicacion/agenda.ts';

type Enviar = (m: unknown) => void;

/**
 * Tablets conectadas por WebSocket, para que el servidor tome la iniciativa (recordatorios de
 * medicación; en el Sprint 8, saludos y seguimientos). Vive en memoria del proceso: con varias
 * instancias, cada una entrega a sus conexiones (TODO Sprint 9: canal compartido).
 */
export class TabletsConectadas implements EntregaTablet {
  private readonly conexiones = new Map<string, Set<Enviar>>();

  constructor(private readonly d: { bd: Bd; voz: ServiciosVoz; catalogo: CatalogoVoces; emergencia: ContactosEmergencia }) {}

  registrar(personaId: string, enviar: Enviar): () => void {
    const s = this.conexiones.get(personaId) ?? this.conexiones.set(personaId, new Set()).get(personaId)!;
    s.add(enviar);
    return () => {
      s.delete(enviar);
      if (s.size === 0) this.conexiones.delete(personaId);
    };
  }

  conectada(personaId: string): boolean {
    return (this.conexiones.get(personaId)?.size ?? 0) > 0;
  }

  /** Recordatorio con la voz de la persona; si la síntesis falla, va solo el texto. */
  async entregar(r: Recordatorio): Promise<boolean> {
    const destinos = this.conexiones.get(r.personaId);
    if (!destinos?.size) return false;
    const perfil = (await leerPerfil(this.d.bd, r.personaId)) ?? PERFIL_POR_DEFECTO;
    const voz = vozDelCatalogo(this.d.catalogo, perfil.voz_id);
    let audio: { mime: string; datos: string } | null = null;
    try {
      const s = await this.d.voz.sintetizador(voz.proveedor).sintetizar({ texto: prepararParaVoz(r.texto, [this.d.emergencia.samu, this.d.emergencia.prevencionSuicidio]), voz, velocidad: perfil.velocidad_voz });
      audio = { mime: s.mime, datos: s.audio.toString('base64') };
    } catch {
      audio = null;
    }
    const mensaje = { tipo: 'recordatorio_dosis', eventoIds: r.eventoIds, programadaEn: r.programadaEn.toISOString(), texto: r.texto, segundoAviso: r.segundoAviso, ...(audio ? { audio } : {}) };
    let entregado = false;
    for (const enviar of destinos) {
      try {
        enviar(mensaje);
        entregado = true;
      } catch {
        // Conexión que se cerró entre medio: la limpia el cierre del socket.
      }
    }
    return entregado;
  }
}
