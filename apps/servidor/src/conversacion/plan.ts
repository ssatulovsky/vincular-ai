import { z } from 'zod';
import { esNivelRiesgo, type UmbralPersonal } from '@vincular/seguridad-clinica';
import type { Cliente, Consultable } from '../db/conexion.ts';
import type { Cifrador } from '../seguridad/cifrado.ts';

/**
 * Plan terapéutico vivo (especificación, sección 7). Lo edita el supervisor clínico; cada
 * cambio es una versión nueva con autor y motivo.
 *
 * Qué ve el agente: objetivos, técnicas, temas a evitar y a explorar e indicaciones.
 * Qué NO ve el agente: la formulación del caso ni la hipótesis clínica. Así no puede
 * mencionarlas, ni siquiera por error. Los términos de `no_mencionar` los bloquea el guardián.
 */
export const esquemaPlan = z.object({
  formulacion: z.string().max(4000).default(''),
  hipotesis: z.string().max(2000).default(''),
  objetivos: z.array(z.string().min(1).max(300)).max(10).default([]),
  tecnicas_indicadas: z.array(z.string().min(1).max(300)).max(10).default([]),
  evitar: z.array(z.string().min(1).max(300)).max(20).default([]),
  temas_a_explorar: z.array(z.string().min(1).max(300)).max(10).default([]),
  indicaciones_para_el_agente: z.string().max(2000).default(''),
  umbrales_alerta: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
        frase: z.string().min(2).max(120),
        nivel: z.number().int().refine(esNivelRiesgo).refine((n) => n >= 1, 'Un umbral personal debe ser nivel 1 a 3'),
        nota: z.string().max(300).optional(),
      }),
    )
    .max(30)
    .default([]),
  no_mencionar: z.array(z.string().min(2).max(80)).max(30).default([]),
  proxima_revision: z.string().date().nullable().default(null),
});

export type PlanTerapeutico = z.infer<typeof esquemaPlan>;

export interface PlanVersionado {
  version: number;
  contenido: PlanTerapeutico;
  autorId: string;
  motivo: string;
  creadoEn: Date;
}

export async function planVigente(bd: Consultable, cifrador: Cifrador, personaId: string): Promise<PlanVersionado | null> {
  const r = await bd.query<{ version: number; contenido_cifrado: Buffer; autor_id: string; motivo: string; creado_en: Date }>(
    'SELECT version, contenido_cifrado, autor_id, motivo, creado_en FROM plan_terapeutico WHERE persona_id = $1 ORDER BY version DESC LIMIT 1',
    [personaId],
  );
  const f = r.rows[0];
  if (!f) return null;
  return { version: f.version, contenido: esquemaPlan.parse(cifrador.descifrarJson(f.contenido_cifrado)), autorId: f.autor_id, motivo: f.motivo, creadoEn: f.creado_en };
}

/** Guarda una versión nueva del plan. `versionBase` evita pisar un cambio concurrente. */
export async function guardarPlan(
  c: Cliente,
  cifrador: Cifrador,
  p: { personaId: string; contenido: PlanTerapeutico; autorId: string; motivo: string; versionBase: number | null },
): Promise<number> {
  await c.query('SELECT id FROM persona WHERE id = $1 FOR UPDATE', [p.personaId]);
  const r = await c.query<{ v: number | null }>('SELECT max(version) AS v FROM plan_terapeutico WHERE persona_id = $1', [p.personaId]);
  const actual = r.rows[0]?.v ?? null;
  if (actual !== p.versionBase) {
    throw Object.assign(new Error(`El plan cambió mientras lo editaba (versión actual ${actual ?? 'ninguna'}). Recargue y vuelva a aplicar su cambio.`), { estado: 409 });
  }
  const version = (actual ?? 0) + 1;
  await c.query('INSERT INTO plan_terapeutico (persona_id, version, contenido_cifrado, autor_id, motivo) VALUES ($1, $2, $3, $4, $5)', [
    p.personaId,
    version,
    cifrador.cifrarJson(p.contenido),
    p.autorId,
    p.motivo.trim(),
  ]);
  return version;
}

export function umbralesDelPlan(plan: PlanTerapeutico | null | undefined): UmbralPersonal[] {
  return (plan?.umbrales_alerta ?? []).map((u) => ({ id: u.id, frase: u.frase, nivel: u.nivel as UmbralPersonal['nivel'], ...(u.nota ? { nota: u.nota } : {}) }));
}
