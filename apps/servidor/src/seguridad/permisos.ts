import type { Consultable } from '../db/conexion.ts';

export type RolPersonal = 'supervisor_clinico' | 'enfermera_enlace' | 'gerontologo' | 'guardia' | 'admin_plataforma';

export type Actor =
  | { tipo: 'personal'; id: string; rol: RolPersonal; nombre: string }
  | { tipo: 'familiar'; id: string; contactoId: string; personaId: string; nombre: string }
  | { tipo: 'dispositivo'; id: string; personaId: string };

export type Accion =
  | 'cuenta.crear'
  | 'persona.crear'
  | 'persona.ver_ficha'
  | 'dispositivo.crear'
  | 'asignacion.gestionar'
  | 'perfil_companero.editar'
  | 'plan.leer'
  | 'plan.editar'
  | 'alertas.leer'
  | 'alertas.acusar'
  | 'transcripcion.leer'
  | 'resumen_bienestar.leer'
  | 'conversacion.usar'
  | 'memoria.propia'
  | 'memoria.ver'
  | 'costos.ver'
  | 'medicacion.gestionar'
  | 'salud.propia'
  | 'hoja_control.ver'
  | 'protocolo.gestionar';

/** Hechos sobre la relación entre el actor y la persona, resueltos desde la base. */
export interface Contexto {
  /** El profesional está asignado a esta persona. */
  asignado: boolean;
  /** Para familiares: el contacto pertenece a esta persona. */
  esSuContacto: boolean;
  /** Para familiares: permisos que la persona otorgó a este contacto. */
  permisosContacto: Record<string, unknown>;
}

const CLINICOS: readonly RolPersonal[] = ['supervisor_clinico', 'enfermera_enlace', 'gerontologo'];

/**
 * Regla central: la persona mayor es la única dueña de la relación. Cada actor ve solo lo que
 * ella autoriza (familiares) o lo que su función clínica requiere con ella (profesionales
 * asignados). El administrador de plataforma gestiona altas y equipos, nunca contenido clínico.
 *
 * Función pura: toda decisión de permisos pasa por aquí y está cubierta por pruebas.
 */
export function decidirPermiso(actor: Actor, accion: Accion, personaId: string | null, ctx: Contexto): boolean {
  if (actor.tipo === 'dispositivo') {
    // La tablet es la persona: conversa, ve, corrige, exporta y borra su memoria, y diseña su compañero.
    return (
      personaId === actor.personaId &&
      (accion === 'conversacion.usar' || accion === 'memoria.propia' || accion === 'perfil_companero.editar' || accion === 'salud.propia' || accion === 'hoja_control.ver')
    );
  }

  if (actor.tipo === 'familiar') {
    if (personaId !== actor.personaId || !ctx.esSuContacto) return false;
    // Un familiar nunca ve transcripciones, planes ni alertas clínicas: solo lo que la persona autorizó.
    if (accion === 'resumen_bienestar.leer') return ctx.permisosContacto.resumen_bienestar === true;
    // La hoja para el control (sin lo privado) puede servirle a quien acompaña a la persona al control.
    if (accion === 'hoja_control.ver') return ctx.permisosContacto.hoja_control === true;
    return false;
  }

  const rol = actor.rol;
  switch (accion) {
    case 'protocolo.gestionar':
      // Protocolos de escalamiento y turnos de guardia: decisión clínica y operativa.
      return rol === 'admin_plataforma' || rol === 'supervisor_clinico';
    case 'cuenta.crear':
    case 'costos.ver':
    case 'persona.crear':
    case 'dispositivo.crear':
    case 'asignacion.gestionar':
      return rol === 'admin_plataforma';
    case 'perfil_companero.editar':
      return rol === 'admin_plataforma' || (CLINICOS.includes(rol) && ctx.asignado);
    case 'persona.ver_ficha':
    case 'plan.leer':
    case 'memoria.ver':
    case 'medicacion.gestionar':
    case 'hoja_control.ver':
      return CLINICOS.includes(rol) && ctx.asignado;
    case 'plan.editar':
    case 'transcripcion.leer':
      return rol === 'supervisor_clinico' && ctx.asignado;
    case 'alertas.leer':
    case 'alertas.acusar':
      // La guardia cubre a todas las personas del piloto; el resto, solo a sus asignadas.
      return rol === 'guardia' || (CLINICOS.includes(rol) && ctx.asignado);
    case 'resumen_bienestar.leer':
    case 'conversacion.usar':
    case 'memoria.propia':
    case 'salud.propia':
      return false;
  }
}

export async function contextoDe(bd: Consultable, actor: Actor, personaId: string | null): Promise<Contexto> {
  const ctx: Contexto = { asignado: false, esSuContacto: false, permisosContacto: {} };
  if (!personaId) return ctx;
  if (actor.tipo === 'personal') {
    const r = await bd.query('SELECT 1 FROM asignacion_personal WHERE cuenta_id = $1 AND persona_id = $2', [actor.id, personaId]);
    ctx.asignado = (r.rowCount ?? 0) > 0;
  } else if (actor.tipo === 'familiar') {
    const r = await bd.query<{ permisos: Record<string, unknown> }>('SELECT permisos FROM contacto WHERE id = $1 AND persona_id = $2', [actor.contactoId, personaId]);
    if (r.rows[0]) {
      ctx.esSuContacto = true;
      ctx.permisosContacto = r.rows[0].permisos;
    }
  }
  return ctx;
}

export class ErrorPermiso extends Error {
  readonly estado = 403;
  constructor() {
    super('No tiene permiso para esta acción');
    this.name = 'ErrorPermiso';
  }
}

export async function exigirPermiso(bd: Consultable, actor: Actor, accion: Accion, personaId: string | null): Promise<void> {
  if (!decidirPermiso(actor, accion, personaId, await contextoDe(bd, actor, personaId))) throw new ErrorPermiso();
}
