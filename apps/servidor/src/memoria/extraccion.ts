import pg from 'pg';
import { z } from 'zod';
import { extraerObjetoJson, type ModelosPorTarea } from '@vincular/ia';
import { normalizar, PATRON_DIAGNOSTICOS } from '@vincular/seguridad-clinica';
import type { Bd } from '../db/conexion.ts';
import { incrustarTextos, llamarModelo } from '../conversacion/llamadas.ts';
import { turnosDeSesion } from '../conversacion/repositorio.ts';
import type { Cifrador } from '../seguridad/cifrado.ts';
import { aLiteralVector } from './episodica.ts';
import { CAPAS, listarHechos, type Capa, type Hecho } from './hechos.ts';

/**
 * Extracción de memoria después de cada sesión.
 *
 * Contra alucinaciones (mismo criterio que los informes clínicos, sección 7):
 *   - Cada hecho, corrección o historia repetida trae una CITA LITERAL de la persona, y el código
 *     verifica que exista en sus turnos de esa sesión. Sin cita válida, se descarta.
 *   - Ningún hecho ni resumen puede contener un diagnóstico que la persona no haya dicho.
 *   - Los hechos nuevos quedan "por confirmar": el agente los retoma con tacto en la siguiente
 *     conversación (confirmación implícita) y la persona puede corregirlos.
 */

export const INSTRUCCIONES_EXTRACCION = `Lees la transcripción de una conversación entre una persona mayor que vive sola en Chile y su compañero conversacional con inteligencia artificial. Tu trabajo es actualizar lo que el compañero recuerda de ella.

Devuelve SOLO JSON con esta forma:
{
  "hechos_nuevos": [{"capa": "biografica|relacional|preferencias|salud", "contenido": "frase breve en tercera persona", "privado": false, "cita": "palabras EXACTAS de la persona que lo sostienen"}],
  "correcciones": [{"hecho_id": "id de un hecho existente", "contenido": "versión corregida", "cita": "palabras EXACTAS de la persona"}],
  "confirmaciones": [{"hecho_id": "id de un hecho por confirmar que la persona confirmó", "cita": "palabras EXACTAS de la persona"}],
  "historias_repetidas": [{"tema": "de qué trata", "cita": "palabras EXACTAS de la persona"}],
  "resumen": "dos a cuatro frases sobre lo conversado, en tercera persona",
  "temas_pendientes": ["algo para retomar la próxima vez, p. ej. 'cómo le fue en el control de la rodilla'"]
}

Reglas:
- Solo datos que la persona DIJO. Nada de interpretaciones, suposiciones ni diagnósticos.
- Datos duraderos y útiles: su historia, sus seres queridos (nombres, relación, dónde viven, fechas importantes), sus gustos, su rutina, su salud tal como ella la cuenta.
- No repitas hechos que ya existen; si la persona dijo algo distinto de un hecho existente, va en "correcciones".
- "privado": true si la persona pidió que algo quede entre ustedes o que no se cuente a su familia.
- "historias_repetidas": solo si cuenta de nuevo una historia que ya aparece en lo que se recuerda. No es un error: es una señal.
- Cada "cita" debe copiarse textual del mensaje de la persona, sin cambiar palabras.
- Si no hay nada que agregar, usa listas vacías.`;

const cita = z.string().trim().min(3).max(400);
export const esquemaExtraccion = z.object({
  hechos_nuevos: z.array(z.object({ capa: z.enum(CAPAS), contenido: z.string().trim().min(3).max(300), privado: z.boolean().default(false), cita })).max(30).default([]),
  correcciones: z.array(z.object({ hecho_id: z.string(), contenido: z.string().trim().min(3).max(300), cita })).max(20).default([]),
  confirmaciones: z.array(z.object({ hecho_id: z.string(), cita })).max(30).default([]),
  historias_repetidas: z.array(z.object({ tema: z.string().trim().min(2).max(120), cita })).max(10).default([]),
  resumen: z.string().trim().max(1200).default(''),
  temas_pendientes: z.array(z.string().trim().min(3).max(200)).max(10).default([]),
});

export interface TurnoPersona {
  id: string;
  texto: string;
}

export interface ExtraccionValida {
  hechosNuevos: Array<{ capa: Capa; contenido: string; privado: boolean; cita: string; turnoId: string }>;
  correcciones: Array<{ hechoId: string; contenido: string; cita: string }>;
  confirmaciones: string[];
  historiasRepetidas: Array<{ tema: string; turnoId: string }>;
  resumen: string | null;
  temasPendientes: string[];
  descartados: Array<{ tipo: string; motivo: string }>;
}

/** Turno de la persona que contiene la cita (comparación normalizada), o null. */
export function turnoDeLaCita(citaTexto: string, turnos: readonly TurnoPersona[]): string | null {
  const c = normalizar(citaTexto);
  if (c.split(' ').length < 2) return null;
  return turnos.find((t) => ` ${normalizar(t.texto)} `.includes(` ${c} `))?.id ?? null;
}

/** Diagnósticos mencionados en `texto` que no aparecen en lo que dijo la persona. */
function diagnosticosNoDichos(texto: string, dichoPorLaPersona: string): string[] {
  const global = new RegExp(PATRON_DIAGNOSTICOS.source, 'g');
  const dicho = normalizar(dichoPorLaPersona);
  return [...normalizar(texto).matchAll(global)].map((m) => m[0]).filter((d) => !dicho.includes(d));
}

/**
 * Valida la salida del modelo contra la transcripción. Función pura: no confía en nada que no
 * pueda comprobar.
 */
export function validarExtraccion(datos: unknown, turnosPersona: readonly TurnoPersona[], hechosExistentes: readonly Hecho[]): ExtraccionValida | null {
  const v = esquemaExtraccion.safeParse(datos);
  if (!v.success) return null;
  const d = v.data;
  const todoLoDicho = turnosPersona.map((t) => t.texto).join(' \n ');
  const existentes = new Map(hechosExistentes.map((h) => [h.id, h]));
  const contenidosExistentes = new Set(hechosExistentes.map((h) => normalizar(h.contenido)));
  const r: ExtraccionValida = { hechosNuevos: [], correcciones: [], confirmaciones: [], historiasRepetidas: [], resumen: null, temasPendientes: [], descartados: [] };

  for (const h of d.hechos_nuevos) {
    const turnoId = turnoDeLaCita(h.cita, turnosPersona);
    if (!turnoId) r.descartados.push({ tipo: 'hecho', motivo: 'cita_no_encontrada' });
    else if (diagnosticosNoDichos(h.contenido, h.cita).length) r.descartados.push({ tipo: 'hecho', motivo: 'diagnostico_no_dicho' });
    else if (contenidosExistentes.has(normalizar(h.contenido))) r.descartados.push({ tipo: 'hecho', motivo: 'duplicado' });
    else {
      contenidosExistentes.add(normalizar(h.contenido));
      r.hechosNuevos.push({ capa: h.capa, contenido: h.contenido, privado: h.privado, cita: h.cita, turnoId });
    }
  }
  for (const c of d.correcciones) {
    if (!existentes.has(c.hecho_id)) r.descartados.push({ tipo: 'correccion', motivo: 'hecho_inexistente' });
    else if (!turnoDeLaCita(c.cita, turnosPersona)) r.descartados.push({ tipo: 'correccion', motivo: 'cita_no_encontrada' });
    else if (diagnosticosNoDichos(c.contenido, c.cita).length) r.descartados.push({ tipo: 'correccion', motivo: 'diagnostico_no_dicho' });
    else r.correcciones.push({ hechoId: c.hecho_id, contenido: c.contenido, cita: c.cita });
  }
  for (const c of d.confirmaciones) {
    const h = existentes.get(c.hecho_id);
    if (!h || h.estado !== 'por_confirmar') r.descartados.push({ tipo: 'confirmacion', motivo: 'hecho_inexistente_o_confirmado' });
    else if (!turnoDeLaCita(c.cita, turnosPersona)) r.descartados.push({ tipo: 'confirmacion', motivo: 'cita_no_encontrada' });
    else if (!r.correcciones.some((x) => x.hechoId === c.hecho_id)) r.confirmaciones.push(c.hecho_id);
  }
  for (const h of d.historias_repetidas) {
    const turnoId = turnoDeLaCita(h.cita, turnosPersona);
    if (turnoId) r.historiasRepetidas.push({ tema: h.tema, turnoId });
    else r.descartados.push({ tipo: 'historia_repetida', motivo: 'cita_no_encontrada' });
  }
  if (d.resumen) {
    if (diagnosticosNoDichos(d.resumen, todoLoDicho).length) r.descartados.push({ tipo: 'resumen', motivo: 'diagnostico_no_dicho' });
    else r.resumen = d.resumen;
  }
  r.temasPendientes = d.temas_pendientes.filter((t) => !diagnosticosNoDichos(t, todoLoDicho).length);
  return r;
}

export interface DependenciasMemoria {
  bd: Bd;
  cifrador: Cifrador;
  modelos: ModelosPorTarea;
}

export type ResultadoProcesamiento =
  | { estado: 'procesada'; hechosNuevos: number; correcciones: number; confirmaciones: number; descartados: number; conEmbedding: boolean }
  | { estado: 'sin_contenido' }
  | { estado: 'ocupada' }
  | { estado: 'ya_procesada' }
  | { estado: 'error'; error: string };

const MAX_INTENTOS = 5;

/**
 * Procesa la memoria de una sesión terminada o inactiva. Idempotente y seguro con varios
 * procesos a la vez (bloqueo consultivo por sesión). Si el modelo falla, la sesión queda
 * pendiente y se reintenta (hasta 5 veces); no se escribe nada a medias.
 */
export async function procesarSesion(d: DependenciasMemoria, sesionId: string): Promise<ResultadoProcesamiento> {
  const c = await d.bd.connect();
  try {
    const bloqueo = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [`memoria:${sesionId}`]);
    if (!bloqueo.rows[0]?.ok) return { estado: 'ocupada' };
    try {
      return await procesarConBloqueo(d, c, sesionId);
    } finally {
      await c.query('SELECT pg_advisory_unlock(hashtext($1))', [`memoria:${sesionId}`]);
    }
  } finally {
    c.release();
  }
}

async function procesarConBloqueo(d: DependenciasMemoria, c: pg.PoolClient, sesionId: string): Promise<ResultadoProcesamiento> {
  const s = await c.query<{ persona_id: string; memoria_procesada_en: Date | null }>('SELECT persona_id, memoria_procesada_en FROM sesion_conversacion WHERE id = $1', [sesionId]);
  const sesion = s.rows[0];
  if (!sesion) return { estado: 'error', error: 'sesión inexistente' };
  if (sesion.memoria_procesada_en) return { estado: 'ya_procesada' };
  const personaId = sesion.persona_id;

  const turnos = await turnosDeSesion(c, d.cifrador, sesionId, 10_000);
  const dePersona = turnos.filter((t) => t.hablante === 'persona').map((t) => ({ id: t.id, texto: t.texto }));
  if (dePersona.length === 0) {
    await c.query('UPDATE sesion_conversacion SET memoria_procesada_en = now() WHERE id = $1', [sesionId]);
    return { estado: 'sin_contenido' };
  }
  const existentes = await listarHechos(c, d.cifrador, personaId, { incluirPrivados: true });

  const transcripcion = turnos.map((t) => `${t.hablante === 'persona' ? 'PERSONA' : 'COMPAÑERO'}: ${t.texto}`).join('\n');
  const memoria = existentes.length
    ? existentes.map((h) => `- [${h.id}] (${h.capa}${h.estado === 'por_confirmar' ? ', por confirmar' : ''}) ${h.contenido}`).join('\n')
    : '(todavía nada)';

  let valida: ExtraccionValida | null;
  try {
    const r = await llamarModelo(c, d.modelos, 'extraccion', { personaId, sesionId }, {
      instrucciones: INSTRUCCIONES_EXTRACCION,
      mensajes: [{ rol: 'usuario', texto: `Lo que el compañero ya recuerda:\n${memoria}\n\nTranscripción:\n${transcripcion}` }],
      respuestaJson: true,
      maxTokens: 2000,
      temperatura: 0,
    });
    valida = r.tipo === 'texto' ? validarExtraccion(extraerObjetoJson(r.texto), dePersona, existentes) : null;
    if (!valida) throw new Error('La extracción no tiene el formato esperado');
  } catch (e) {
    const error = (e as Error).message.slice(0, 300);
    await c.query(
      `UPDATE sesion_conversacion SET memoria_intentos = memoria_intentos + 1, memoria_ultimo_error = $2,
         memoria_procesada_en = CASE WHEN memoria_intentos + 1 >= $3 THEN now() ELSE NULL END
       WHERE id = $1`,
      [sesionId, error, MAX_INTENTOS],
    );
    return { estado: 'error', error };
  }

  // El embedding se pide fuera de la transacción; si falla, el resumen se guarda igual y se
  // encuentra por palabras.
  let vector: { valor: number[]; proveedor: string; modelo: string } | null = null;
  if (valida.resumen) {
    try {
      const e = await incrustarTextos(c, d.modelos, { personaId, sesionId }, [valida.resumen], 'documento');
      vector = { valor: e.vectores[0]!, proveedor: e.proveedor, modelo: e.modelo };
    } catch {
      vector = null;
    }
  }

  await c.query('BEGIN');
  try {
    for (const h of valida.hechosNuevos) {
      await c.query(
        `INSERT INTO hecho_memoria (persona_id, capa, contenido_cifrado, privado, estado, fuente, origen_turno_id, sesion_origen_id, cita_cifrada)
         VALUES ($1, $2, $3, $4, 'por_confirmar', 'extraccion', $5, $6, $7)`,
        [personaId, h.capa, d.cifrador.cifrar(h.contenido), h.privado, h.turnoId, sesionId, d.cifrador.cifrar(h.cita)],
      );
    }
    for (const x of valida.correcciones) {
      await c.query(
        `UPDATE hecho_memoria SET contenido_cifrado = $3, estado = 'confirmado', corregido_en = now(), actualizado_en = now(), cita_cifrada = $4
         WHERE id = $1 AND persona_id = $2`,
        [x.hechoId, personaId, d.cifrador.cifrar(x.contenido), d.cifrador.cifrar(x.cita)],
      );
    }
    for (const id of valida.confirmaciones) {
      await c.query(`UPDATE hecho_memoria SET estado = 'confirmado', actualizado_en = now() WHERE id = $1 AND persona_id = $2`, [id, personaId]);
    }
    // La repetición de historias es una señal, no un error (sección 4.6).
    for (const h of valida.historiasRepetidas) {
      await c.query('INSERT INTO senal (persona_id, tipo, valor, origen_turno_id) VALUES ($1, $2, 1, $3)', [personaId, 'memoria.historia_repetida', h.turnoId]);
    }
    if (valida.resumen) {
      await c.query(
        `INSERT INTO embedding_memoria (persona_id, sesion_id, resumen_cifrado, temas_pendientes_cifrado, embedding, proveedor, modelo)
         VALUES ($1, $2, $3, $4, $5::vector, $6, $7)`,
        [personaId, sesionId, d.cifrador.cifrar(valida.resumen), d.cifrador.cifrarJson(valida.temasPendientes), vector ? aLiteralVector(vector.valor) : null, vector?.proveedor ?? null, vector?.modelo ?? null],
      );
    }
    await c.query(
      `INSERT INTO registro_auditoria (actor_tipo, accion, recurso_tipo, recurso_id, persona_id, detalle) VALUES ('sistema', 'memoria.extraccion', 'sesion_conversacion', $1, $2, $3)`,
      [sesionId, personaId, { hechosNuevos: valida.hechosNuevos.length, correcciones: valida.correcciones.length, confirmaciones: valida.confirmaciones.length, descartados: valida.descartados }],
    );
    await c.query('UPDATE sesion_conversacion SET memoria_procesada_en = now(), memoria_ultimo_error = NULL WHERE id = $1', [sesionId]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
  return {
    estado: 'procesada',
    hechosNuevos: valida.hechosNuevos.length,
    correcciones: valida.correcciones.length,
    confirmaciones: valida.confirmaciones.length,
    descartados: valida.descartados.length,
    conEmbedding: vector !== null,
  };
}

/**
 * Sesiones listas para procesar: cerradas, o sin turnos nuevos desde hace `minutosInactividad`
 * (la tablet no siempre cierra la sesión). Se usa desde la CLI y, en el Sprint 8, desde el
 * planificador.
 */
export async function procesarPendientes(d: DependenciasMemoria, opciones: { minutosInactividad?: number; limite?: number } = {}): Promise<ResultadoProcesamiento[]> {
  const r = await d.bd.query<{ id: string }>(
    `SELECT id FROM sesion_conversacion
      WHERE memoria_procesada_en IS NULL AND memoria_intentos < $1
        AND (fin IS NOT NULL OR coalesce(ultimo_turno_en, inicio) < now() - make_interval(mins => $2))
      ORDER BY inicio LIMIT $3`,
    [MAX_INTENTOS, opciones.minutosInactividad ?? 30, opciones.limite ?? 50],
  );
  const resultados: ResultadoProcesamiento[] = [];
  for (const f of r.rows) resultados.push(await procesarSesion(d, f.id));
  return resultados;
}
