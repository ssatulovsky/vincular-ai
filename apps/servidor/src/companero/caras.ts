import type { Consultable } from '../db/conexion.ts';
import { leerImagenAvatar } from './avatares.ts';
import { crearCaraSimli, ErrorSimli, estadoCaraSimli, type AccesoSimli } from './simli.ts';

/**
 * Caras de Simli (decisión 0017). Simli no anima el retrato directamente: primero construye una
 * "cara" a partir de él (unas 4 horas) y el plan tiene un cupo mensual de caras. Por eso:
 *  - la cara se pide recién cuando la persona conversa con ese retrato (no se gastan caras en
 *    retratos que nadie usa), en segundo plano, sin demorar la conversación;
 *  - mientras no esté lista, se usa la cara de prueba si está configurada, o el retrato que respira;
 *  - si se acabó el cupo o falló, se reintenta al día siguiente.
 */

export type EstadoCara = 'solicitando' | 'construyendo' | 'lista' | 'fallida' | 'sin_cupo' | 'error';

/** Cada cuánto se reintenta una cara que no se pudo pedir o que se quedó sin cupo. */
export const REINTENTO_HORAS = 24;
/** Una solicitud que lleva más de esto sin respuesta se da por perdida y se puede repetir. */
const SOLICITUD_PERDIDA_MIN = 15;

interface FilaCara {
  cara_id: string | null;
  estado: EstadoCara;
  actualizado_en: Date;
}

type Registro = (msg: string, extra?: Record<string, unknown>) => void;

export type CaraParaSesion = { caraId: string; propia: boolean } | null;

/**
 * La cara con la que conversar ahora. Si hace falta, consulta el estado (rápido) o encarga la
 * construcción en segundo plano. `trabajos` recibe la promesa de esa construcción (para pruebas).
 */
export async function caraSimliParaSesion(e: {
  bd: Consultable;
  acceso: AccesoSimli;
  caraPrueba: string | null;
  personaId: string;
  avatarId: string;
  registro: Registro;
  trabajos?: Array<Promise<void>>;
}): Promise<CaraParaSesion> {
  const prueba: CaraParaSesion = e.caraPrueba ? { caraId: e.caraPrueba, propia: false } : null;
  let fila = await leerCara(e.bd, e.avatarId);

  if (fila?.estado === 'construyendo' && fila.cara_id) {
    try {
      const estado = await estadoCaraSimli(e.acceso, fila.cara_id);
      if (estado !== 'construyendo') {
        await actualizarCara(e.bd, e.avatarId, estado, estado === 'fallida' ? 'Simli no pudo construir la cara' : null);
        e.registro('agente.cara_avatar', { estado });
        fila = { ...fila, estado };
      }
    } catch (err) {
      // Sin respuesta de Simli: se sigue con lo que hay; se vuelve a consultar en la próxima conversación.
      e.registro('agente.cara_avatar_sin_estado', { error: (err as Error).message.slice(0, 120) });
    }
  }
  if (fila?.estado === 'lista' && fila.cara_id) return { caraId: fila.cara_id, propia: true };

  if (debePedirse(fila)) {
    const trabajo = encargarCara(e).catch((err: Error) => e.registro('agente.cara_avatar_falla', { error: err.message.slice(0, 160) }));
    e.trabajos?.push(trabajo);
  }
  return prueba;
}

/** Regla pura: ¿hay que pedir (o volver a pedir) la cara? */
export function debePedirse(fila: { estado: EstadoCara; actualizado_en: Date } | null, ahora = new Date()): boolean {
  if (!fila) return true;
  const horas = (ahora.getTime() - fila.actualizado_en.getTime()) / 3_600_000;
  if (fila.estado === 'solicitando') return horas * 60 >= SOLICITUD_PERDIDA_MIN;
  if (fila.estado === 'error' || fila.estado === 'sin_cupo' || fila.estado === 'fallida') return horas >= REINTENTO_HORAS;
  return false;
}

async function encargarCara(e: { bd: Consultable; acceso: AccesoSimli; personaId: string; avatarId: string; registro: Registro }): Promise<void> {
  // Se "reserva" la solicitud: si dos conversaciones parten a la vez, solo una gasta una cara.
  const reservada = await e.bd.query(
    `INSERT INTO cara_avatar (avatar_id, proveedor, persona_id, estado) VALUES ($1, 'simli', $2, 'solicitando')
     ON CONFLICT (avatar_id, proveedor) DO UPDATE SET estado = 'solicitando', cara_id = NULL, detalle = NULL, actualizado_en = now()
       WHERE cara_avatar.estado IN ('error', 'sin_cupo', 'fallida', 'solicitando')
         AND cara_avatar.actualizado_en < now() - make_interval(mins => CASE WHEN cara_avatar.estado = 'solicitando' THEN $3 ELSE $4 * 60 END)
     RETURNING 1`,
    [e.avatarId, e.personaId, SOLICITUD_PERDIDA_MIN, REINTENTO_HORAS],
  );
  if (reservada.rowCount === 0) return;

  const retrato = await leerImagenAvatar(e.bd, e.personaId, e.avatarId);
  if (!retrato) {
    await actualizarCara(e.bd, e.avatarId, 'error', 'El retrato ya no existe');
    return;
  }
  try {
    // El nombre en Simli no lleva datos de la persona: solo el identificador del retrato.
    const caraId = await crearCaraSimli(e.acceso, retrato, `vincular-${e.avatarId.slice(0, 8)}`);
    await e.bd.query(`UPDATE cara_avatar SET estado = 'construyendo', cara_id = $2, actualizado_en = now() WHERE avatar_id = $1 AND proveedor = 'simli'`, [e.avatarId, caraId]);
    e.registro('agente.cara_avatar', { estado: 'construyendo' });
  } catch (err) {
    const sinCupo = err instanceof ErrorSimli && err.sinCupo;
    await actualizarCara(e.bd, e.avatarId, sinCupo ? 'sin_cupo' : 'error', (err as Error).message);
    e.registro('agente.cara_avatar', { estado: sinCupo ? 'sin_cupo' : 'error' });
  }
}

async function leerCara(bd: Consultable, avatarId: string): Promise<FilaCara | null> {
  const r = await bd.query<FilaCara>(`SELECT cara_id, estado, actualizado_en FROM cara_avatar WHERE avatar_id = $1 AND proveedor = 'simli'`, [avatarId]);
  return r.rows[0] ?? null;
}

async function actualizarCara(bd: Consultable, avatarId: string, estado: EstadoCara, detalle: string | null): Promise<void> {
  await bd.query(`UPDATE cara_avatar SET estado = $2, detalle = $3, actualizado_en = now() WHERE avatar_id = $1 AND proveedor = 'simli'`, [
    avatarId,
    estado,
    detalle ? detalle.replace(/\s+/g, ' ').slice(0, 300) : null,
  ]);
}

/** Para el panel: estado de la cara animada del retrato que la persona tiene elegido. */
export async function estadoCaraDePersona(bd: Consultable, personaId: string): Promise<{ estado: EstadoCara; actualizadoEn: Date } | null> {
  const r = await bd.query<{ estado: EstadoCara; actualizado_en: Date }>(
    `SELECT c.estado, c.actualizado_en FROM cara_avatar c JOIN perfil_companero p ON p.avatar_id = c.avatar_id::text
      WHERE p.persona_id = $1 AND c.proveedor = 'simli'`,
    [personaId],
  );
  return r.rows[0] ? { estado: r.rows[0].estado, actualizadoEn: r.rows[0].actualizado_en } : null;
}
