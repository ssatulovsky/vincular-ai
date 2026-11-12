import { ErrorProveedor, type ModelosPorTarea, type PeticionModelo, type RespuestaModelo, type Tarea } from '@vincular/ia';
import type { Consultable } from '../db/conexion.ts';

export interface AmbitoUso {
  personaId: string | null;
  sesionId: string | null;
}

/**
 * Llama al modelo de una tarea y registra el uso (tokens y latencia) para medir el costo por
 * persona al mes. Si la tarea no tiene modelo configurado, lanza ErrorProveedor como si el
 * proveedor no respondiera: el llamador aplica su política conservadora.
 */
export async function llamarModelo(
  bd: Consultable,
  modelos: ModelosPorTarea,
  tarea: Tarea,
  ambito: AmbitoUso,
  peticion: PeticionModelo,
): Promise<RespuestaModelo> {
  let modelo;
  try {
    modelo = modelos.para(tarea);
  } catch (e) {
    throw new ErrorProveedor('gemini', `La tarea "${tarea}" no tiene modelo disponible`, undefined, (e as Error).message);
  }
  if (!modelo.modelo) throw new ErrorProveedor(modelo.proveedor, `La tarea "${tarea}" no tiene modelo configurado (IA_MODELO_${tarea.toUpperCase()})`);
  const inicio = performance.now();
  try {
    const r = await modelo.responder(peticion);
    await registrar(bd, tarea, modelo.proveedor, modelo.modelo, ambito, Math.round(performance.now() - inicio), r.uso.tokensEntrada, r.uso.tokensSalida, null);
    return r;
  } catch (e) {
    const detalle = e instanceof ErrorProveedor ? `${e.message}${e.estado ? ` (${e.estado})` : ''}` : (e as Error).message;
    await registrar(bd, tarea, modelo.proveedor, modelo.modelo, ambito, Math.round(performance.now() - inicio), 0, 0, detalle).catch(() => undefined);
    throw e;
  }
}

async function registrar(
  bd: Consultable,
  tarea: Tarea,
  proveedor: string,
  modelo: string,
  a: AmbitoUso,
  latencia: number,
  entrada: number,
  salida: number,
  error: string | null,
): Promise<void> {
  await bd.query(
    `INSERT INTO uso_modelo (persona_id, sesion_id, tarea, proveedor, modelo, tokens_entrada, tokens_salida, latencia_ms, ok, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [a.personaId, a.sesionId, tarea, proveedor, modelo, entrada, salida, latencia, error === null, error],
  );
}
