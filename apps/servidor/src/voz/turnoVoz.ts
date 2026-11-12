import { detectarRiesgoPorReglas, type ContactosEmergencia } from '@vincular/seguridad-clinica';
import { dividirEnFrases, prepararParaVoz, vozDelCatalogo, type CatalogoVoces, type ResultadoReconocimiento, type ServiciosVoz, type VozConfigurada } from '@vincular/voz';
import type { Bd } from '../db/conexion.ts';
import type { Orquestador } from '../conversacion/orquestador.ts';
import { leerPerfil, PERFIL_POR_DEFECTO, type PerfilCompanero } from '../conversacion/perfil.ts';

/**
 * Turno hablado: audio → voz a texto → orquestador (detector de riesgo y guardián, igual que
 * por texto) → texto a voz por frases. El audio de la persona no se guarda.
 *
 * Mensajes que emite (en orden):
 *   transcripcion   lo que se entendió (se muestra como subtítulo para que pueda corregir)
 *   respuesta       el texto de la respuesta (subtítulo), con nivel y modo emergencia
 *   audio_respuesta una por frase, en orden
 *   sin_audio       si la síntesis falla: la respuesta queda solo como texto en pantalla
 *   no_entendi      si no se pudo reconocer o la confianza fue baja (y no había señal de riesgo)
 */

export type MensajeVoz =
  | { tipo: 'transcripcion'; texto: string; confianza: number | null }
  | { tipo: 'respuesta'; texto: string; nivel: number; modoEmergencia: boolean }
  | { tipo: 'audio_respuesta'; indice: number; total: number; mime: string; datos: string }
  | { tipo: 'sin_audio'; texto: string }
  | { tipo: 'no_entendi'; texto: string; motivo: 'reconocimiento_no_disponible' | 'sin_texto' | 'confianza_baja' }
  | { tipo: 'fin_turno' };

export interface DependenciasVoz {
  bd: Bd;
  orquestador: Orquestador;
  servicios: ServiciosVoz;
  catalogo: CatalogoVoces;
  umbralConfianza: number;
  emergencia: ContactosEmergencia;
}

export const MAX_BYTES_AUDIO = 2 * 1024 * 1024;

function pedirRepetir(p: PerfilCompanero): string {
  return p.trato === 'tu' ? 'Perdona, no te escuché bien. ¿Me lo repites, por favor?' : 'Disculpe, no le escuché bien. ¿Me lo repite, por favor?';
}

export async function procesarTurnoVoz(
  d: DependenciasVoz,
  e: { sesionId: string; personaId: string; audio: Buffer; mime: string },
  emitir: (m: MensajeVoz) => void,
): Promise<void> {
  const inicio = performance.now();
  const desde = () => Math.round(performance.now() - inicio);
  const perfil = (await leerPerfil(d.bd, e.personaId)) ?? PERFIL_POR_DEFECTO;
  const voz = vozDelCatalogo(d.catalogo, perfil.voz_id);
  const medicion: Record<string, unknown> = { stt_ok: false, pidio_repetir: false };
  const idioma = d.servicios.config.reconocimiento.idioma;

  let reconocido: ResultadoReconocimiento | null = null;
  let reconocedor: { proveedor: string; modelo: string } = { proveedor: d.servicios.config.reconocimiento.proveedor, modelo: '?' };
  try {
    const r = d.servicios.reconocedor();
    reconocedor = { proveedor: r.proveedor, modelo: r.modelo };
    reconocido = await r.reconocer({ audio: e.audio, mime: e.mime, idioma });
    Object.assign(medicion, { stt_ok: true, stt_ms: reconocido.latenciaMs, stt_confianza: reconocido.confianza, stt_segundos_audio: reconocido.segundosAudio });
  } catch {
    reconocido = null;
  }

  try {
    let textoParaHablar: string;
    let turnoAgenteId: string | null = null;

    const texto = reconocido?.texto.trim() ?? '';
    // Con baja confianza se pide repetir, salvo que lo entendido ya traiga una señal de riesgo:
    // ante la duda, se procesa.
    const confianzaBaja = reconocido?.confianza != null && reconocido.confianza < d.umbralConfianza && detectarRiesgoPorReglas(texto).nivel < 2;
    if (!reconocido || texto.length === 0 || confianzaBaja) {
      textoParaHablar = pedirRepetir(perfil);
      medicion.pidio_repetir = true;
      if (texto) emitir({ tipo: 'transcripcion', texto, confianza: reconocido?.confianza ?? null });
      emitir({ tipo: 'no_entendi', texto: textoParaHablar, motivo: !reconocido ? 'reconocimiento_no_disponible' : texto ? 'confianza_baja' : 'sin_texto' });
    } else {
      emitir({ tipo: 'transcripcion', texto, confianza: reconocido.confianza });
      const t0 = performance.now();
      const r = await d.orquestador.procesarTurno(e.sesionId, e.personaId, texto);
      medicion.orquestador_ms = Math.round(performance.now() - t0);
      turnoAgenteId = r.turnoId;
      textoParaHablar = r.respuesta;
      emitir({ tipo: 'respuesta', texto: r.respuesta, nivel: r.nivel, modoEmergencia: r.modoEmergencia });
    }

    await hablar(d, voz, perfil.velocidad_voz, textoParaHablar, emitir, medicion, desde);
    await registrar(d.bd, e, reconocedor, voz, turnoAgenteId, medicion);
  } catch (err) {
    await registrar(d.bd, e, reconocedor, voz, null, medicion).catch(() => undefined);
    throw err;
  } finally {
    emitir({ tipo: 'fin_turno' });
  }
}

/** Sintetiza por frases y las emite en orden; si falla, el texto queda en pantalla. */
async function hablar(
  d: DependenciasVoz,
  voz: VozConfigurada,
  velocidad: number,
  texto: string,
  emitir: (m: MensajeVoz) => void,
  medicion: Record<string, unknown>,
  desde: () => number,
): Promise<void> {
  const frases = dividirEnFrases(prepararParaVoz(texto, [d.emergencia.samu, d.emergencia.prevencionSuicidio]));
  Object.assign(medicion, { tts_proveedor: voz.proveedor, tts_motor: voz.motor, tts_voz_id: voz.id, tts_frases: frases.length, tts_ok: true });
  let caracteres = 0;
  try {
    const sintetizador = d.servicios.sintetizador(voz.proveedor);
    for (const [i, frase] of frases.entries()) {
      const s = await sintetizador.sintetizar({ texto: frase, voz, velocidad });
      caracteres += s.caracteres;
      if (i === 0) Object.assign(medicion, { tts_primer_audio_ms: s.latenciaMs, total_primer_audio_ms: desde() });
      emitir({ tipo: 'audio_respuesta', indice: i, total: frases.length, mime: s.mime, datos: s.audio.toString('base64') });
    }
  } catch {
    medicion.tts_ok = false;
    emitir({ tipo: 'sin_audio', texto });
  }
  medicion.tts_caracteres = caracteres;
}

async function registrar(
  bd: Bd,
  e: { sesionId: string; personaId: string },
  stt: { proveedor: string; modelo: string },
  voz: VozConfigurada,
  turnoAgenteId: string | null,
  m: Record<string, unknown>,
): Promise<void> {
  await bd.query(
    `INSERT INTO medicion_voz (persona_id, sesion_id, turno_agente_id, stt_proveedor, stt_modelo, stt_ms, stt_confianza, stt_segundos_audio, stt_ok, pidio_repetir,
       orquestador_ms, tts_proveedor, tts_motor, tts_voz_id, tts_caracteres, tts_frases, tts_primer_audio_ms, tts_ok, total_primer_audio_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
    [
      e.personaId,
      e.sesionId,
      turnoAgenteId,
      stt.proveedor,
      stt.modelo,
      m.stt_ms ?? null,
      m.stt_confianza ?? null,
      m.stt_segundos_audio ?? null,
      m.stt_ok,
      m.pidio_repetir,
      m.orquestador_ms ?? null,
      m.tts_proveedor ?? voz.proveedor,
      m.tts_motor ?? voz.motor,
      m.tts_voz_id ?? voz.id,
      m.tts_caracteres ?? 0,
      m.tts_frases ?? 0,
      m.tts_primer_audio_ms ?? null,
      m.tts_ok ?? null,
      m.total_primer_audio_ms ?? null,
    ],
  );
}
