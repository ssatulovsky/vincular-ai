import type { Consultable } from '../db/conexion.ts';
import type { Cifrador } from '../seguridad/cifrado.ts';
import type { InformeSesion } from '../informes/sesion.ts';
import { citasProximas } from '../medicacion/citas.ts';

/**
 * Resumen de bienestar para la familia (especificación: "Resumen de bienestar, nunca
 * transcripciones; alertas acordadas; puede proponer recordatorios").
 *
 * Solo categorías y cifras calculadas por el código: no incluye ningún texto de las
 * conversaciones ni de la IA, ni temas privados, ni el plan, ni tamizajes, ni niveles de riesgo,
 * ni lecturas teóricas. Cada parte aparece solo si la persona la autorizó para este contacto.
 */

export interface PermisosFamilia {
  resumen_bienestar?: boolean;
  avisos_medicacion?: boolean;
  hoja_control?: boolean;
}

export type Categoria = 'bien' | 'regular' | 'bajo' | 'sin_datos';

export interface ResumenBienestar {
  persona: { nombre: string };
  autorizado: { bienestar: boolean; medicacion: boolean; citas: boolean };
  bienestar: { diasConConversacion: number; dias: boolean[]; animo: Categoria; descanso: 'bien' | 'con_dificultades' | 'sin_datos'; contactosHumanos: number; contactosSemanaAnterior: number } | null;
  medicacion: { confirmadas: number; total: number } | null;
  citas: Array<{ id: string; fecha: Date; lugar: string }> | null;
  avisos: Array<{ fecha: Date; tipo: 'alerta' | 'emergencia' | 'medicacion'; canal: string | null; atendido: boolean }>;
}

const DIA = 86_400_000;

export function categoriaAnimo(valores: readonly number[]): Categoria {
  if (!valores.length) return 'sin_datos';
  const p = valores.reduce((a, b) => a + b, 0) / valores.length;
  // TODO(clinico): cortes provisorios para mostrar a la familia.
  return p >= 0.5 ? 'bien' : p > -0.5 ? 'regular' : 'bajo';
}

export async function resumenBienestar(bd: Consultable, cifrador: Cifrador, personaId: string, contactoId: string, permisos: PermisosFamilia, ahora = new Date()): Promise<ResumenBienestar> {
  const p = await bd.query<{ nombre_cifrado: Buffer }>('SELECT nombre_cifrado FROM persona WHERE id = $1', [personaId]);
  // Solo el primer nombre: lo necesario para saludar.
  const nombre = cifrador.descifrar(p.rows[0]!.nombre_cifrado).split(' ')[0]!;
  const hace7 = new Date(ahora.getTime() - 7 * DIA);
  const hace14 = new Date(ahora.getTime() - 14 * DIA);
  const autorizado = { bienestar: permisos.resumen_bienestar === true, medicacion: permisos.avisos_medicacion === true, citas: permisos.hoja_control === true };

  let bienestar: ResumenBienestar['bienestar'] = null;
  if (autorizado.bienestar) {
    // Los últimos 7 días (del más antiguo a hoy), en la zona horaria de la persona: ¿conversó?
    const dias = await bd.query<{ hablo: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM sesion_conversacion s WHERE s.persona_id = p.id AND (s.inicio AT TIME ZONE p.zona_horaria)::date = d.dia
                        AND EXISTS (SELECT 1 FROM turno t WHERE t.sesion_id = s.id AND t.hablante = 'persona')) AS hablo
         FROM persona p, generate_series(($2::timestamptz AT TIME ZONE (SELECT zona_horaria FROM persona WHERE id = $1))::date - 6,
                                         ($2::timestamptz AT TIME ZONE (SELECT zona_horaria FROM persona WHERE id = $1))::date, interval '1 day') AS d(dia)
        WHERE p.id = $1 ORDER BY d.dia`,
      [personaId, ahora],
    );
    const diasHablo = dias.rows.map((x) => x.hablo);
    const informes = await bd.query<{ inicio: Date; contenido_cifrado: Buffer }>(
      `SELECT s.inicio, i.contenido_cifrado FROM informe_sesion i JOIN sesion_conversacion s ON s.id = i.sesion_id
        WHERE s.persona_id = $1 AND i.estado_validacion = 'valido' AND s.inicio >= $2`,
      [personaId, hace14],
    );
    const animos: number[] = [];
    let malDormido = 0;
    let conSueno = 0;
    let contactos = 0;
    let contactosAntes = 0;
    for (const f of informes.rows) {
      const ind = (cifrador.descifrarJson(f.contenido_cifrado) as InformeSesion).indicadores;
      if (!ind) continue;
      if (f.inicio >= hace7) {
        if (ind.animo) animos.push(ind.animo.valor);
        if (ind.sueno) {
          conSueno++;
          if (ind.sueno.valor === 'malo') malDormido++;
        }
        contactos += ind.contactos_humanos?.length ?? 0;
      } else {
        contactosAntes += ind.contactos_humanos?.length ?? 0;
      }
    }
    bienestar = {
      diasConConversacion: diasHablo.filter(Boolean).length,
      dias: diasHablo,
      animo: categoriaAnimo(animos),
      // Una sola noche mala contada ya no es "duerme bien".
      descanso: conSueno === 0 ? 'sin_datos' : malDormido > 0 ? 'con_dificultades' : 'bien',
      contactosHumanos: contactos,
      contactosSemanaAnterior: contactosAntes,
    };
  }

  let medicacion: ResumenBienestar['medicacion'] = null;
  if (autorizado.medicacion) {
    const r = await bd.query<{ confirmadas: number; total: number }>(
      `SELECT count(*) FILTER (WHERE e.estado = 'confirmada')::int AS confirmadas,
              count(*) FILTER (WHERE e.estado IN ('confirmada', 'omitida', 'sin_respuesta'))::int AS total
         FROM evento_dosis e JOIN medicamento m ON m.id = e.medicamento_id
        WHERE m.persona_id = $1 AND e.programada_en >= $2 AND e.programada_en <= $3`,
      [personaId, hace7, ahora],
    );
    medicacion = r.rows[0] ?? { confirmadas: 0, total: 0 };
  }

  const citas = autorizado.citas ? (await citasProximas(bd, cifrador, personaId, ahora, 60)).map((c) => ({ id: c.id, fecha: c.fecha, lugar: c.lugar })) : null;

  // Los avisos que recibió ESTE contacto (sin ningún detalle clínico), y si el equipo ya los atendió.
  const av = await bd.query<{ creada_en: Date; tipo: string; canal: string | null; nivel: number | null; tipo_evento: string | null; esc_estado: string | null; acusada: boolean }>(
    `SELECT n.creada_en, n.tipo, n.canal, e.nivel, e.tipo_evento, e.estado AS esc_estado, (n.estado = 'acusada') AS acusada
       FROM notificacion n LEFT JOIN escalamiento e ON e.id = n.escalamiento_id
      WHERE n.persona_id = $1 AND n.destinatario_contacto_id = $2 AND n.creada_en >= $3
      ORDER BY n.creada_en DESC LIMIT 20`,
    [personaId, contactoId, new Date(ahora.getTime() - 30 * DIA)],
  );
  const avisos = av.rows.map((x) => ({
    fecha: x.creada_en,
    tipo: (x.tipo_evento === 'dosis_sin_respuesta' || x.tipo.includes('dosis') || x.tipo.includes('medicacion') ? 'medicacion' : (x.nivel ?? 0) >= 3 ? 'emergencia' : 'alerta') as 'alerta' | 'emergencia' | 'medicacion',
    canal: x.canal,
    // Atendido = alguien acusó recibo. Una cadena agotada o cancelada no es lo mismo.
    atendido: x.acusada || x.esc_estado === 'acusado',
  }));

  return { persona: { nombre }, autorizado, bienestar, medicacion, citas, avisos };
}
