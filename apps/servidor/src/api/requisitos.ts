import { hayEmergenciaPendiente } from '../conversacion/repositorio.ts';
import { auditar } from '../seguridad/auditoria.ts';
import type { Actor } from '../seguridad/permisos.ts';
import { mensajeRequisitos, requisitosPendientes } from '../seguridad/requisitos.ts';
import { ErrorHttp, type Aplicacion } from './servidor.ts';

/**
 * Antes de abrir una conversación: consentimiento, evaluación de ingreso y estado (decisión 0018).
 * Nunca bloquea si hay una emergencia en curso sin acuse humano: ahí el compañero sigue disponible.
 * El bloqueo queda en la auditoría (el panel de preparación lo muestra al equipo).
 */
export async function exigirRequisitosConversacion(app: Aplicacion, actor: Extract<Actor, { tipo: 'dispositivo' }>): Promise<void> {
  const faltan = await requisitosPendientes(app.bd, actor.personaId);
  if (faltan.length === 0) return;
  if (await hayEmergenciaPendiente(app.bd, actor.personaId)) return;
  await auditar(app.bd, actor, { accion: 'conversacion.bloqueada_requisitos', recursoTipo: 'persona', recursoId: actor.personaId, personaId: actor.personaId, detalle: { faltan } });
  throw new ErrorHttp(409, mensajeRequisitos(faltan, app.config.emergencia), { codigo: 'requisitos_pendientes', faltan, emergencia: app.config.emergencia });
}
