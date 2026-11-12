import { z } from 'zod';
import { revisarRespuestaPorReglas } from '@vincular/seguridad-clinica';
import type { Consultable } from '../db/conexion.ts';

/**
 * Perfil del compañero que la persona diseña. Es el ÚLTIMO en la precedencia de instrucciones:
 * no puede convertirlo en pareja, hacerlo pasar por humano ni darle una vida humana inventada.
 */
export const esquemaPerfil = z
  .object({
    nombre: z.string().trim().min(1).max(40),
    personalidad: z.string().trim().max(600).default(''),
    forma_de_hablar: z.string().trim().max(600).default(''),
    trato: z.enum(['usted', 'tu']).default('usted'),
    voz_id: z.string().max(80).nullable().default(null),
    avatar_id: z.string().max(80).nullable().default(null),
    rol_preferente: z.enum(['equilibrado', 'amigo', 'enfermero', 'consejero', 'puente']).default('equilibrado'),
    // La base devuelve numeric como texto: se convierte.
    velocidad_voz: z.coerce.number().min(0.7).max(1.2).default(1),
  })
  .superRefine((p, ctx) => {
    const texto = `${p.nombre}. ${p.personalidad}. ${p.forma_de_hablar}`;
    const prohibidas = revisarRespuestaPorReglas(texto).problemas.filter((x) =>
      ['romantico', 'se_hace_pasar_por_humano', 'vida_humana_inventada', 'venta_publicidad', 'culpa_por_ausencia'].includes(x.categoria),
    );
    const sinTildes = texto.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
    const humano = /\b(eres|sea|seas|fueras|fuera|como si|actua como|actue como|finge|finja|imita|imite)\b.{0,30}\b(humano|humana|persona real|de carne y hueso)\b/.test(sinTildes);
    // Ni pareja ni imitación de un cónyuge (la imitación de un ser querido fallecido está fuera del producto).
    const pareja = /\b(novi[oa]s?|pareja|enamorad[oa]|amante|espos[oa]|marido|pololo|polola|mi viejo|mi vieja)\b/.test(sinTildes);
    if (prohibidas.length > 0 || humano || pareja) {
      ctx.addIssue({
        code: 'custom',
        path: ['personalidad'],
        message: 'El compañero no puede ser una pareja romántica, hacerse pasar por humano ni tener una vida humana inventada.',
      });
    }
  });

export type PerfilCompanero = z.infer<typeof esquemaPerfil>;

export const PERFIL_POR_DEFECTO: PerfilCompanero = {
  nombre: 'Compañero',
  personalidad: 'Cálido, paciente, curioso y con buen humor.',
  forma_de_hablar: 'Frases cortas y claras.',
  trato: 'usted',
  voz_id: null,
  avatar_id: null,
  rol_preferente: 'equilibrado',
  velocidad_voz: 1,
};

const COLUMNAS = 'nombre, personalidad, forma_de_hablar, trato, voz_id, avatar_id, rol_preferente, velocidad_voz';

export async function leerPerfil(bd: Consultable, personaId: string): Promise<PerfilCompanero | null> {
  const r = await bd.query(`SELECT ${COLUMNAS} FROM perfil_companero WHERE persona_id = $1`, [personaId]);
  return r.rows[0] ? esquemaPerfil.parse(r.rows[0]) : null;
}

export async function guardarPerfil(bd: Consultable, personaId: string, p: PerfilCompanero): Promise<void> {
  await bd.query(
    `INSERT INTO perfil_companero (persona_id, ${COLUMNAS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (persona_id) DO UPDATE SET nombre = EXCLUDED.nombre, personalidad = EXCLUDED.personalidad, forma_de_hablar = EXCLUDED.forma_de_hablar,
       trato = EXCLUDED.trato, voz_id = EXCLUDED.voz_id, avatar_id = EXCLUDED.avatar_id, rol_preferente = EXCLUDED.rol_preferente,
       velocidad_voz = EXCLUDED.velocidad_voz, actualizado_en = now()`,
    [personaId, p.nombre, p.personalidad, p.forma_de_hablar, p.trato, p.voz_id, p.avatar_id, p.rol_preferente, p.velocidad_voz],
  );
}
