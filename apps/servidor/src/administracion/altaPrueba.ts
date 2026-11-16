import { transaccion, type Bd } from '../db/conexion.ts';
import { auditar } from '../seguridad/auditoria.ts';
import type { Cifrador } from '../seguridad/cifrado.ts';
import { nuevoToken } from '../seguridad/tokens.ts';

export interface DatosAltaPrueba {
  nombre: string;
  comuna: string;
  nombreDispositivo: string;
}

/**
 * Alta de una persona de prueba con su tablet, en una sola transacción, para probar el prototipo
 * en un servidor recién instalado sin pasar por la API de administración.
 *
 * El token de la tablet se devuelve UNA vez; en la base solo queda su hash (igual que en la API).
 * La persona queda en estado 'onboarding' y marcada en la auditoría como alta de prueba: no es
 * para personas reales.
 */
export async function altaPersonaDePrueba(bd: Bd, cifrador: Cifrador, d: DatosAltaPrueba): Promise<{ personaId: string; dispositivoId: string; token: string }> {
  const nombre = d.nombre.trim();
  const comuna = d.comuna.trim();
  const nombreDispositivo = d.nombreDispositivo.trim();
  if (nombre.length < 2 || nombre.length > 120) throw new Error('El nombre debe tener entre 2 y 120 caracteres');
  if (comuna.length < 2 || comuna.length > 80) throw new Error('La comuna debe tener entre 2 y 80 caracteres');
  if (nombreDispositivo.length < 2 || nombreDispositivo.length > 80) throw new Error('El nombre del dispositivo debe tener entre 2 y 80 caracteres');

  const { token, hash } = nuevoToken();
  return transaccion(bd, async (c) => {
    const p = await c.query<{ id: string }>('INSERT INTO persona (nombre_cifrado, comuna) VALUES ($1, $2) RETURNING id', [cifrador.cifrar(nombre), comuna]);
    const personaId = p.rows[0]!.id;
    const disp = await c.query<{ id: string }>('INSERT INTO dispositivo (persona_id, nombre, token_hash) VALUES ($1, $2, $3) RETURNING id', [personaId, nombreDispositivo, hash]);
    const dispositivoId = disp.rows[0]!.id;
    await auditar(c, { tipo: 'sistema' }, { accion: 'persona.crear_prueba_cli', recursoTipo: 'persona', recursoId: personaId, personaId });
    await auditar(c, { tipo: 'sistema' }, { accion: 'dispositivo.crear_prueba_cli', recursoTipo: 'dispositivo', recursoId: dispositivoId, personaId });
    return { personaId, dispositivoId, token };
  });
}
