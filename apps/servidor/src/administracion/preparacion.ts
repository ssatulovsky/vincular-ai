import type { Consultable } from '../db/conexion.ts';
import type { Config } from '../config/config.ts';

/**
 * Verificación de preparación del piloto (decisión 0018): lo que el sistema puede comprobar solo
 * (protocolos, guardia 24/7, mensajería, requisitos de cada persona) y lo que hay que marcar a
 * mano (acuerdos legales y clínicos). Es lo que hay que tener en verde antes de entregar tablets.
 */

export type Estado = 'ok' | 'falta' | 'revisar';

export interface Chequeo {
  clave: string;
  titulo: string;
  estado: Estado;
  detalle: string;
}

/** Tareas que nadie puede verificar por código: se marcan a mano con una nota. */
export const TAREAS_MANUALES: Record<string, { titulo: string; ayuda: string }> = {
  guardia_institucion: { titulo: 'Institución de guardia clínica 24/7 formalizada', ayuda: 'Convenio o acuerdo firmado con quien responde las alertas de nivel 2 y 3 a toda hora.' },
  protocolo_validado: { titulo: 'Protocolo de riesgo validado por el equipo clínico', ayuda: 'Plazos de acuse, cadena de contactos, criterios de exclusión y redacción de los avisos (TODO clínico).' },
  consentimiento_validado: { titulo: 'Consentimiento informado revisado por abogado y equipo clínico', ayuda: 'Texto en lenguaje simple, versión vigente y procedimiento con representante legal.' },
  eipd: { titulo: 'Evaluación de impacto en protección de datos', ayuda: 'Datos sensibles de salud y emocionales (Ley 21.719): riesgos y medidas.' },
  rat: { titulo: 'Registro de actividades de tratamiento', ayuda: 'Finalidades, categorías de datos, plazos, encargados y transferencias.' },
  dpa_modelos: { titulo: 'Acuerdo de tratamiento con el proveedor de modelos de lenguaje', ayuda: 'Sin uso para entrenamiento y retención mínima (transferencia internacional).' },
  dpa_voz: { titulo: 'Acuerdo de tratamiento con el proveedor de voz (ElevenLabs)', ayuda: 'Transcripción y síntesis de voz: retención y transferencia internacional.' },
  dpa_avatar: { titulo: 'Acuerdo de tratamiento con el proveedor del avatar (si se usa)', ayuda: 'Recibe el audio de lo que dice el compañero.' },
  dpa_mensajeria: { titulo: 'Acuerdo con el proveedor de SMS y llamadas', ayuda: 'Teléfonos de cuidadores y guardia.' },
  opinion_isp: { titulo: 'Opinión sobre la clasificación ante el ISP', ayuda: 'Respaldo escrito de que, tal como se usa, no es un dispositivo médico.' },
  numeros_emergencia: { titulo: 'Números de emergencia verificados para la comuna', ayuda: 'SAMU 131, línea *4141 y Fono Mayor vigentes.' },
};

/** Huecos de la guardia de riesgo en una semana tipo, por hora (pura, para pruebas). */
export function huecosGuardia(turnos: Array<{ dias: number[]; horaDesde: string; horaHasta: string }>): Array<{ dia: number; hora: number }> {
  const cubre = (t: (typeof turnos)[number], dia: number, minuto: number) => {
    const desde = aMinutos(t.horaDesde);
    const hasta = aMinutos(t.horaHasta);
    if (desde <= hasta) return t.dias.includes(dia) && minuto >= desde && minuto <= hasta;
    // Turno que cruza la medianoche: la parte de la madrugada pertenece al día siguiente.
    const diaAnterior = dia === 1 ? 7 : dia - 1;
    return (t.dias.includes(dia) && minuto >= desde) || (t.dias.includes(diaAnterior) && minuto <= hasta);
  };
  const huecos: Array<{ dia: number; hora: number }> = [];
  for (let dia = 1; dia <= 7; dia++) {
    for (let hora = 0; hora < 24; hora++) {
      // Se revisa el inicio y el final de cada hora.
      const ok = [hora * 60, hora * 60 + 59].every((m) => turnos.some((t) => cubre(t, dia, m)));
      if (!ok) huecos.push({ dia, hora });
    }
  }
  return huecos;
}

function aMinutos(h: string): number {
  const [hh, mm] = h.split(':').map(Number);
  return hh! * 60 + mm!;
}

const DIAS = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

function describirHuecos(h: Array<{ dia: number; hora: number }>): string {
  const porDia = new Map<number, number[]>();
  for (const x of h) porDia.set(x.dia, [...(porDia.get(x.dia) ?? []), x.hora]);
  return [...porDia.entries()]
    .slice(0, 3)
    .map(([d, horas]) => `${DIAS[d]} ${horas.length === 24 ? 'todo el día' : `${horas[0]}:00 a ${horas[horas.length - 1]! + 1}:00`}`)
    .join('; ') + (porDia.size > 3 ? '…' : '');
}

export async function verificarPreparacion(bd: Consultable, config: Pick<Config, 'escalamiento' | 'emergencia'>) {
  const chequeos: Chequeo[] = [];

  // 1. Protocolos de riesgo para nivel 3 y 2.
  const prot = await bd.query<{ nivel: number | null }>(`SELECT nivel FROM protocolo_escalamiento WHERE activo AND tipo_evento = 'riesgo' AND persona_id IS NULL`);
  for (const nivel of [3, 2]) {
    const hay = prot.rows.some((p) => p.nivel === null || p.nivel === nivel);
    chequeos.push({
      clave: `protocolo_riesgo_${nivel}`,
      titulo: `Protocolo de escalamiento para riesgo de nivel ${nivel}`,
      estado: hay ? 'ok' : 'falta',
      detalle: hay ? 'Configurado y activo.' : `No hay un protocolo activo que cubra el nivel ${nivel}: las alertas avisarían solo a la guardia por defecto.`,
    });
  }

  // 2. Guardia de riesgo 24/7.
  const tg = await bd.query<{ dias: number[]; hora_desde: string; hora_hasta: string }>(
    `SELECT dias, to_char(hora_desde, 'HH24:MI') AS hora_desde, to_char(hora_hasta, 'HH24:MI') AS hora_hasta FROM turno_guardia
      WHERE activo AND current_date BETWEEN vigente_desde AND coalesce(vigente_hasta, 'infinity'::date)
        AND (cardinality(cubre) = 0 OR 'riesgo' = ANY(cubre) OR 'riesgo:3' = ANY(cubre))`,
  );
  const huecos = huecosGuardia(tg.rows.map((t) => ({ dias: t.dias, horaDesde: t.hora_desde, horaHasta: t.hora_hasta === '23:59' ? '23:59' : t.hora_hasta })));
  chequeos.push({
    clave: 'guardia_24_7',
    titulo: 'Guardia clínica cubre las 24 horas, los 7 días',
    estado: tg.rowCount === 0 ? 'falta' : huecos.length === 0 ? 'ok' : 'falta',
    detalle: tg.rowCount === 0 ? 'No hay turnos de guardia vigentes para riesgo.' : huecos.length === 0 ? `${tg.rowCount} turno(s) vigente(s) sin horas descubiertas.` : `Horas sin guardia: ${describirHuecos(huecos)}.`,
  });

  // 3. SMS y llamadas.
  chequeos.push({
    clave: 'mensajeria',
    titulo: 'SMS y llamadas automáticas configurados',
    estado: config.escalamiento.twilio ? 'ok' : 'falta',
    detalle: config.escalamiento.twilio ? 'El proveedor está configurado.' : 'Sin proveedor de SMS y llamadas: las alertas solo se verían en el panel.',
  });

  // 4. Números de emergencia.
  chequeos.push({
    clave: 'emergencia',
    titulo: 'Números de emergencia configurados',
    estado: config.emergencia.verificados ? 'ok' : 'revisar',
    detalle: `SAMU ${config.emergencia.samu}, prevención del suicidio ${config.emergencia.prevencionSuicidio}${config.emergencia.verificados ? ', marcados como verificados.' : '. Falta marcarlos como verificados.'}`,
  });

  // 5. Personas: requisitos para conversar, equipo y cuidador.
  const per = await bd.query<{ id: string; nombre_cifrado: Buffer; sin_consentimiento: boolean; sin_evaluacion: boolean; sin_equipo: boolean; sin_cuidador: boolean; bloqueos: number }>(
    `WITH hoy AS (SELECT (now() AT TIME ZONE 'America/Santiago')::date AS d)
     SELECT p.id, p.nombre_cifrado,
            NOT (coalesce(p.consentimiento_vigente_hasta >= hoy.d, false) AND EXISTS (SELECT 1 FROM consentimiento k WHERE k.persona_id = p.id AND k.revocado_en IS NULL)) AS sin_consentimiento,
            NOT coalesce((SELECT e.resultado <> 'no_apto' AND e.revisar_antes_de >= hoy.d FROM evaluacion_ingreso e WHERE e.persona_id = p.id ORDER BY e.creado_en DESC LIMIT 1), false) AS sin_evaluacion,
            NOT EXISTS (SELECT 1 FROM asignacion_personal a JOIN cuenta c ON c.id = a.cuenta_id AND c.activa WHERE a.persona_id = p.id AND c.rol IN ('supervisor_clinico', 'psiquiatra')) AS sin_equipo,
            NOT EXISTS (SELECT 1 FROM contacto c WHERE c.persona_id = p.id AND c.es_cuidador AND c.dado_de_baja_en IS NULL) AS sin_cuidador,
            (SELECT count(*)::int FROM registro_auditoria r WHERE r.persona_id = p.id AND r.accion = 'conversacion.bloqueada_requisitos' AND r.creado_en > now() - interval '7 days') AS bloqueos
       FROM persona p, hoy WHERE p.estado IN ('onboarding', 'activa')`,
  );
  const personas = per.rows.map((x) => ({
    id: x.id,
    nombre_cifrado: x.nombre_cifrado,
    faltan: [x.sin_consentimiento && 'consentimiento', x.sin_evaluacion && 'evaluación de ingreso', x.sin_equipo && 'psiquiatra o psicólogo/a supervisor/a asignado/a', x.sin_cuidador && 'contacto cuidador'].filter(Boolean) as string[],
    bloqueos: x.bloqueos,
  }));
  const incompletas = personas.filter((p) => p.faltan.length > 0);
  chequeos.push({
    clave: 'personas',
    titulo: 'Cada persona con consentimiento, evaluación de ingreso, responsable clínico y cuidador',
    estado: personas.length === 0 ? 'revisar' : incompletas.length === 0 ? 'ok' : 'falta',
    detalle: personas.length === 0 ? 'Aún no hay personas activas.' : incompletas.length === 0 ? `${personas.length} persona(s) en regla.` : `${incompletas.length} de ${personas.length} con pendientes (detalle abajo).`,
  });

  const man = await bd.query<{ clave: string; completado: boolean; nota: string; actualizado_en: Date; por: string | null }>(
    `SELECT m.clave, m.completado, m.nota, m.actualizado_en, c.nombre AS por FROM preparacion_manual m LEFT JOIN cuenta c ON c.id = m.actualizado_por`,
  );
  const marcadas = new Map(man.rows.map((m) => [m.clave, m]));
  const manuales = Object.entries(TAREAS_MANUALES).map(([clave, t]) => {
    const m = marcadas.get(clave);
    return { clave, ...t, completado: m?.completado ?? false, nota: m?.nota ?? '', actualizadoEn: m?.actualizado_en ?? null, por: m?.por ?? null };
  });

  return { chequeos, personas: incompletas, manuales };
}
