import { z } from 'zod';
import type { EspecificacionHerramienta } from '@vincular/ia';
import { esNivelRiesgo, normalizar, type NivelRiesgo } from '@vincular/seguridad-clinica';
import type { Consultable } from '../db/conexion.ts';
import type { Cifrador } from '../seguridad/cifrado.ts';

/**
 * Herramientas del agente. Todas operan SOLO sobre la persona de la sesión: el identificador
 * de la persona lo pone el servidor, nunca el modelo.
 *
 * Sprint 1: memoria básica y reporte de riesgo. El resto (medicación, citas, catálogo
 * comunitario, contactos, tamizaje) llega en sus sprints.
 */

export interface AmbitoHerramienta {
  bd: Consultable;
  cifrador: Cifrador;
  personaId: string;
  turnoPersonaId: string;
  /** El agente reportó riesgo: el orquestador lo combina (solo puede subir el nivel). */
  alReportarRiesgo: (nivel: NivelRiesgo, motivo: string) => void;
}

interface Herramienta<E> {
  especificacion: EspecificacionHerramienta;
  entrada: z.ZodType<E>;
  ejecutar(a: AmbitoHerramienta, e: E): Promise<unknown>;
}

const CAPAS = ['biografica', 'relacional', 'preferencias', 'salud'] as const;

const memoriaBuscar: Herramienta<{ consulta: string }> = {
  especificacion: {
    nombre: 'memoria_buscar',
    descripcion: 'Busca en lo que sabes de la persona (su historia, sus seres queridos, sus gustos y su rutina de salud). Úsala cuando necesites un dato que no está en tus instrucciones.',
    esquemaEntrada: { type: 'object', properties: { consulta: { type: 'string', description: 'Palabras clave, p. ej. "nieta" o "jardín"' } }, required: ['consulta'] },
  },
  entrada: z.object({ consulta: z.string().min(1).max(200) }),
  async ejecutar(a, e) {
    // Sprint 1: búsqueda por palabras sobre los hechos descifrados. Sprint 2: búsqueda semántica (pgvector).
    const r = await a.bd.query<{ id: string; capa: string; contenido_cifrado: Buffer }>(
      'SELECT id, capa, contenido_cifrado FROM hecho_memoria WHERE persona_id = $1 AND vigente ORDER BY actualizado_en DESC LIMIT 500',
      [a.personaId],
    );
    const palabras = normalizar(e.consulta).split(' ').filter((p) => p.length > 2);
    const hechos = r.rows
      .map((f) => ({ id: f.id, capa: f.capa, contenido: a.cifrador.descifrar(f.contenido_cifrado) }))
      .filter((h) => palabras.length === 0 || palabras.some((p) => normalizar(h.contenido).includes(p)))
      .slice(0, 10);
    return { hechos };
  },
};

const memoriaGuardarHecho: Herramienta<{ capa: (typeof CAPAS)[number]; contenido: string; privado: boolean }> = {
  especificacion: {
    nombre: 'memoria_guardar_hecho',
    descripcion:
      'Guarda un dato importante y duradero que la persona contó (p. ej. "Su nieta Camila vive en Temuco"). Solo datos que ella dijo, nunca interpretaciones. Marca privado=true si pidió que quede entre ustedes.',
    esquemaEntrada: {
      type: 'object',
      properties: {
        capa: { type: 'string', enum: [...CAPAS] },
        contenido: { type: 'string', description: 'Una frase en tercera persona' },
        privado: { type: 'boolean' },
      },
      required: ['capa', 'contenido', 'privado'],
    },
  },
  entrada: z.object({ capa: z.enum(CAPAS), contenido: z.string().trim().min(3).max(300), privado: z.boolean().default(false) }),
  async ejecutar(a, e) {
    const r = await a.bd.query<{ id: string }>(
      'INSERT INTO hecho_memoria (persona_id, capa, contenido_cifrado, privado, origen_turno_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [a.personaId, e.capa, a.cifrador.cifrar(e.contenido), e.privado, a.turnoPersonaId],
    );
    return { guardado: true, id: r.rows[0]!.id };
  },
};

const riesgoReportar: Herramienta<{ nivel: number; motivo: string }> = {
  especificacion: {
    nombre: 'riesgo_reportar',
    descripcion:
      'Reporta una preocupación por la seguridad o la salud de la persona. Niveles: 1 atención (ánimo bajo, mal sueño), 2 alerta (desesperanza, caída, estafa, desorientación), 3 emergencia (deseo de morir, dolor en el pecho, signos de ACV, caída con lesión). Ante la duda, el nivel más alto.',
    esquemaEntrada: {
      type: 'object',
      properties: { nivel: { type: 'integer', enum: [1, 2, 3] }, motivo: { type: 'string' } },
      required: ['nivel', 'motivo'],
    },
  },
  entrada: z.object({ nivel: z.number().int().refine((n) => esNivelRiesgo(n) && n >= 1), motivo: z.string().max(300) }),
  async ejecutar(a, e) {
    a.alReportarRiesgo(e.nivel as NivelRiesgo, e.motivo);
    return { registrado: true };
  },
};

export const HERRAMIENTAS = [memoriaBuscar, memoriaGuardarHecho, riesgoReportar] as const;

export const ESPECIFICACIONES: EspecificacionHerramienta[] = HERRAMIENTAS.map((h) => h.especificacion);

export async function ejecutarHerramienta(a: AmbitoHerramienta, nombre: string, entrada: unknown): Promise<unknown> {
  const h = HERRAMIENTAS.find((x) => x.especificacion.nombre === nombre) as Herramienta<unknown> | undefined;
  if (!h) return { error: `Herramienta desconocida: ${nombre}` };
  const v = h.entrada.safeParse(entrada);
  if (!v.success) return { error: `Entrada inválida: ${v.error.issues.map((i) => i.message).join('; ')}` };
  return h.ejecutar(a, v.data);
}
