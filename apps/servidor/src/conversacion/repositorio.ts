import type { Bd, Consultable } from '../db/conexion.ts';
import { transaccion } from '../db/conexion.ts';
import type { Cifrador } from '../seguridad/cifrado.ts';
import { esquemaPerfil, PERFIL_POR_DEFECTO, type PerfilCompanero } from './perfil.ts';

export interface SesionConversacion {
  id: string;
  personaId: string;
  fin: Date | null;
  nivelMaximo: number;
  modoEmergencia: boolean;
  categoriasEmergencia: string[];
}

export type OrigenTurno = 'persona' | 'modelo' | 'modelo_regenerado' | 'respuesta_segura' | 'protocolo_emergencia';

export async function abrirSesion(bd: Consultable, personaId: string, dispositivoId: string | null, iniciadaPor: 'persona' | 'agente' | 'sistema', canal: 'texto' | 'voz'): Promise<string> {
  const r = await bd.query<{ id: string }>(
    'INSERT INTO sesion_conversacion (persona_id, dispositivo_id, iniciada_por, canal) VALUES ($1, $2, $3, $4) RETURNING id',
    [personaId, dispositivoId, iniciadaPor, canal],
  );
  return r.rows[0]!.id;
}

export async function leerSesion(bd: Consultable, sesionId: string): Promise<SesionConversacion | null> {
  const r = await bd.query<{ id: string; persona_id: string; fin: Date | null; nivel_maximo: number; modo_emergencia: boolean; categorias_emergencia: string[] }>(
    'SELECT id, persona_id, fin, nivel_maximo, modo_emergencia, categorias_emergencia FROM sesion_conversacion WHERE id = $1',
    [sesionId],
  );
  const f = r.rows[0];
  return f ? { id: f.id, personaId: f.persona_id, fin: f.fin, nivelMaximo: f.nivel_maximo, modoEmergencia: f.modo_emergencia, categoriasEmergencia: f.categorias_emergencia } : null;
}

/** Inserta un turno con el siguiente número de orden, serializado por sesión. */
export async function insertarTurno(bd: Bd, cifrador: Cifrador, sesionId: string, personaId: string, hablante: 'persona' | 'agente', texto: string, origen: OrigenTurno): Promise<string> {
  return transaccion(bd, async (c) => {
    await c.query('SELECT 1 FROM sesion_conversacion WHERE id = $1 FOR UPDATE', [sesionId]);
    const r = await c.query<{ id: string }>(
      `INSERT INTO turno (sesion_id, persona_id, orden, hablante, texto_cifrado, origen)
       VALUES ($1, $2, (SELECT coalesce(max(orden), 0) + 1 FROM turno WHERE sesion_id = $1), $3, $4, $5) RETURNING id`,
      [sesionId, personaId, hablante, cifrador.cifrar(texto), origen],
    );
    return r.rows[0]!.id;
  });
}

export async function turnosDeSesion(bd: Consultable, cifrador: Cifrador, sesionId: string, limite = 40): Promise<Array<{ id: string; hablante: 'persona' | 'agente'; texto: string; origen: OrigenTurno; creadoEn: Date }>> {
  const r = await bd.query<{ id: string; hablante: 'persona' | 'agente'; texto_cifrado: Buffer; origen: OrigenTurno; creado_en: Date }>(
    `SELECT * FROM (SELECT id, hablante, texto_cifrado, origen, creado_en, orden FROM turno WHERE sesion_id = $1 ORDER BY orden DESC LIMIT $2) t ORDER BY orden`,
    [sesionId, limite],
  );
  return r.rows.map((f) => ({ id: f.id, hablante: f.hablante, texto: cifrador.descifrar(f.texto_cifrado), origen: f.origen, creadoEn: f.creado_en }));
}

export interface ContextoPersona {
  nombre: string;
  perfil: PerfilCompanero;
  hechos: Array<{ capa: string; contenido: string }>;
}

export async function contextoPersona(bd: Consultable, cifrador: Cifrador, personaId: string): Promise<ContextoPersona> {
  const p = await bd.query<{ nombre_cifrado: Buffer }>('SELECT nombre_cifrado FROM persona WHERE id = $1', [personaId]);
  if (!p.rows[0]) throw new Error('Persona inexistente');
  const perfil = await bd.query('SELECT nombre, personalidad, forma_de_hablar, trato, voz_id, avatar_id, rol_preferente FROM perfil_companero WHERE persona_id = $1', [personaId]);
  const hechos = await bd.query<{ capa: string; contenido_cifrado: Buffer }>(
    'SELECT capa, contenido_cifrado FROM hecho_memoria WHERE persona_id = $1 AND vigente ORDER BY actualizado_en DESC LIMIT 60',
    [personaId],
  );
  // Primer nombre: suficiente para conversar y no expone el nombre completo al proveedor.
  const nombre = cifrador.descifrar(p.rows[0].nombre_cifrado).trim().split(/\s+/)[0] ?? '';
  return {
    nombre,
    perfil: perfil.rows[0] ? esquemaPerfil.parse(perfil.rows[0]) : PERFIL_POR_DEFECTO,
    hechos: hechos.rows.map((h) => ({ capa: h.capa, contenido: cifrador.descifrar(h.contenido_cifrado) })),
  };
}
