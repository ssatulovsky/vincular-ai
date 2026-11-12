import { z } from 'zod';
import type { EspecificacionHerramienta, ModelosPorTarea } from '@vincular/ia';
import { esNivelRiesgo, normalizar, type NivelRiesgo } from '@vincular/seguridad-clinica';
import type { Bd } from '../db/conexion.ts';
import { confirmarDosis, diaLocal, dosisEntre, registrarOmision } from '../medicacion/agenda.ts';
import { anotarPregunta, citasProximas } from '../medicacion/citas.ts';
import { buscarEpisodios } from '../memoria/episodica.ts';
import { CAPAS, confirmarHecho, corregirHecho, crearHecho, listarHechos, marcarPrivado, olvidarHecho } from '../memoria/hechos.ts';
import { auditar } from '../seguridad/auditoria.ts';
import type { Cifrador } from '../seguridad/cifrado.ts';

/**
 * Herramientas del agente. Todas operan SOLO sobre la persona de la sesión: el identificador
 * de la persona lo pone el servidor, nunca el modelo. Un `hecho_id` de otra persona no existe.
 *
 * Sprint 2: memoria completa ("¿qué recuerdas de mí?", corregir, olvidar, privado, confirmar)
 * y reporte de riesgo. Medicación, citas, catálogo comunitario, contactos y tamizaje llegan
 * en sus sprints.
 */

export interface AmbitoHerramienta {
  bd: Bd;
  cifrador: Cifrador;
  modelos: ModelosPorTarea;
  personaId: string;
  sesionId: string;
  dispositivoId: string | null;
  turnoPersonaId: string;
  ahora: () => Date;
  /** El agente reportó riesgo: el orquestador lo combina (solo puede subir el nivel). */
  alReportarRiesgo: (nivel: NivelRiesgo, motivo: string) => void;
}

interface Herramienta<E> {
  especificacion: EspecificacionHerramienta;
  entrada: z.ZodType<E>;
  ejecutar(a: AmbitoHerramienta, e: E): Promise<unknown>;
}

const idHecho = z.string().uuid();
const noEncontrado = { error: 'No encontré ese recuerdo.' };

async function registrarCambio(a: AmbitoHerramienta, accion: string, hechoId: string): Promise<void> {
  // Sin contenido: la auditoría registra qué se hizo, no qué decía.
  await auditar(a.bd, a.dispositivoId ? { tipo: 'dispositivo', id: a.dispositivoId, personaId: a.personaId } : { tipo: 'sistema' }, {
    accion,
    recursoTipo: 'hecho_memoria',
    recursoId: hechoId,
    personaId: a.personaId,
    detalle: { via: 'conversacion', sesionId: a.sesionId },
  });
}

const memoriaBuscar: Herramienta<{ consulta: string }> = {
  especificacion: {
    nombre: 'memoria_buscar',
    descripcion:
      'Busca en lo que recuerdas de la persona: datos (su historia, sus seres queridos, sus gustos, su salud) y conversaciones anteriores. Úsala cuando necesites algo que no está en tus instrucciones.',
    esquemaEntrada: { type: 'object', properties: { consulta: { type: 'string', description: 'Qué buscas, p. ej. "su nieta" o "la operación de la rodilla"' } }, required: ['consulta'] },
  },
  entrada: z.object({ consulta: z.string().min(1).max(200) }),
  async ejecutar(a, e) {
    const palabras = normalizar(e.consulta).split(' ').filter((p) => p.length > 2);
    const hechos = (await listarHechos(a.bd, a.cifrador, a.personaId, { incluirPrivados: true }))
      .filter((h) => palabras.length === 0 || palabras.some((p) => normalizar(h.contenido).includes(p)))
      .slice(0, 10)
      .map((h) => ({ id: h.id, capa: h.capa, contenido: h.contenido, privado: h.privado, porConfirmar: h.estado === 'por_confirmar' }));
    const ep = await buscarEpisodios(a.bd, a.cifrador, a.modelos, a.personaId, a.sesionId, e.consulta, 3);
    return {
      hechos,
      conversaciones: ep.episodios.map((x) => ({ fecha: x.fecha.toISOString().slice(0, 10), resumen: x.resumen, temasPendientes: x.temasPendientes })),
    };
  },
};

const memoriaQueRecuerdo: Herramienta<Record<string, never>> = {
  especificacion: {
    nombre: 'memoria_que_recuerdo',
    descripcion:
      'Devuelve TODO lo que recuerdas de la persona, con el identificador de cada dato. Úsala cuando pregunte "¿qué sabes de mí?" o "¿qué recuerdas de mí?". Cuéntaselo de forma breve y ordenada, y ofrécele corregir, olvidar o dejar como privado lo que quiera.',
    esquemaEntrada: { type: 'object', properties: {} },
  },
  entrada: z.object({}) as unknown as z.ZodType<Record<string, never>>,
  async ejecutar(a) {
    const hechos = await listarHechos(a.bd, a.cifrador, a.personaId, { incluirPrivados: true });
    const porCapa = Object.fromEntries(CAPAS.map((c) => [c, hechos.filter((h) => h.capa === c).map((h) => ({ id: h.id, contenido: h.contenido, privado: h.privado, porConfirmar: h.estado === 'por_confirmar' }))]));
    return { total: hechos.length, porCapa };
  },
};

const memoriaGuardarHecho: Herramienta<{ capa: (typeof CAPAS)[number]; contenido: string; privado: boolean }> = {
  especificacion: {
    nombre: 'memoria_guardar_hecho',
    descripcion:
      'Guarda un dato importante y duradero que la persona te acaba de contar (p. ej. "Su nieta Camila vive en Temuco"). Solo lo que ella dijo, nunca interpretaciones. privado=true si pidió que quede entre ustedes.',
    esquemaEntrada: {
      type: 'object',
      properties: { capa: { type: 'string', enum: [...CAPAS] }, contenido: { type: 'string', description: 'Una frase en tercera persona' }, privado: { type: 'boolean' } },
      required: ['capa', 'contenido', 'privado'],
    },
  },
  entrada: z.object({ capa: z.enum(CAPAS), contenido: z.string().trim().min(3).max(300), privado: z.boolean().default(false) }),
  async ejecutar(a, e) {
    // Lo que el modelo anota queda "por confirmar": la persona lo puede corregir después.
    const id = await crearHecho(a.bd, a.cifrador, a.personaId, { ...e, estado: 'por_confirmar', fuente: 'conversacion', origenTurnoId: a.turnoPersonaId, sesionOrigenId: a.sesionId });
    return { guardado: true, id };
  },
};

const memoriaCorregir: Herramienta<{ hecho_id: string; contenido: string }> = {
  especificacion: {
    nombre: 'memoria_corregir',
    descripcion: 'Corrige un dato que recuerdas mal, con lo que la persona te acaba de decir. Lo que ella dice prevalece.',
    esquemaEntrada: { type: 'object', properties: { hecho_id: { type: 'string' }, contenido: { type: 'string', description: 'El dato corregido, en tercera persona' } }, required: ['hecho_id', 'contenido'] },
  },
  entrada: z.object({ hecho_id: idHecho, contenido: z.string().trim().min(3).max(300) }),
  async ejecutar(a, e) {
    if (!(await corregirHecho(a.bd, a.cifrador, a.personaId, e.hecho_id, e.contenido))) return noEncontrado;
    await registrarCambio(a, 'memoria.corregir', e.hecho_id);
    return { corregido: true };
  },
};

const memoriaConfirmar: Herramienta<{ hecho_id: string }> = {
  especificacion: {
    nombre: 'memoria_confirmar',
    descripcion: 'Marca como confirmado un dato "por confirmar" cuando la persona te dice que es correcto.',
    esquemaEntrada: { type: 'object', properties: { hecho_id: { type: 'string' } }, required: ['hecho_id'] },
  },
  entrada: z.object({ hecho_id: idHecho }),
  async ejecutar(a, e) {
    return (await confirmarHecho(a.bd, a.personaId, e.hecho_id)) ? { confirmado: true } : noEncontrado;
  },
};

const memoriaOlvidar: Herramienta<{ hecho_id: string }> = {
  especificacion: {
    nombre: 'memoria_olvidar',
    descripcion: 'Olvida para siempre un dato. ANTES de usarla, confirma con la persona qué quiere que olvides. Después dile que ya no lo recordarás.',
    esquemaEntrada: { type: 'object', properties: { hecho_id: { type: 'string' } }, required: ['hecho_id'] },
  },
  entrada: z.object({ hecho_id: idHecho }),
  async ejecutar(a, e) {
    if (!(await olvidarHecho(a.bd, a.personaId, e.hecho_id))) return noEncontrado;
    await registrarCambio(a, 'memoria.olvidar', e.hecho_id);
    return { olvidado: true };
  },
};

const memoriaPrivado: Herramienta<{ hecho_id: string; privado: boolean }> = {
  especificacion: {
    nombre: 'memoria_privado',
    descripcion: 'Marca un dato como privado (queda entre ustedes: nunca aparece en lo que ve su familia) o lo deja de ser.',
    esquemaEntrada: { type: 'object', properties: { hecho_id: { type: 'string' }, privado: { type: 'boolean' } }, required: ['hecho_id', 'privado'] },
  },
  entrada: z.object({ hecho_id: idHecho, privado: z.boolean() }),
  async ejecutar(a, e) {
    if (!(await marcarPrivado(a.bd, a.personaId, e.hecho_id, e.privado))) return noEncontrado;
    await registrarCambio(a, e.privado ? 'memoria.marcar_privado' : 'memoria.quitar_privado', e.hecho_id);
    return { privado: e.privado };
  },
};

const riesgoReportar: Herramienta<{ nivel: number; motivo: string }> = {
  especificacion: {
    nombre: 'riesgo_reportar',
    descripcion:
      'Reporta una preocupación por la seguridad o la salud de la persona. Niveles: 1 atención (ánimo bajo, mal sueño), 2 alerta (desesperanza, caída, estafa, desorientación), 3 emergencia (deseo de morir, dolor en el pecho, signos de ACV, caída con lesión). Ante la duda, el nivel más alto.',
    esquemaEntrada: { type: 'object', properties: { nivel: { type: 'integer', enum: [1, 2, 3] }, motivo: { type: 'string' } }, required: ['nivel', 'motivo'] },
  },
  entrada: z.object({ nivel: z.number().int().refine((n) => esNivelRiesgo(n) && n >= 1), motivo: z.string().max(300) }),
  async ejecutar(a, e) {
    a.alReportarRiesgo(e.nivel as NivelRiesgo, e.motivo);
    return { registrado: true };
  },
};

// ── Enfermero digital ─────────────────────────────────────────────────────────────
// Ninguna herramienta permite cambiar, saltar ni duplicar una dosis: solo informar el horario
// indicado por el equipo de salud y registrar lo que la persona dice que hizo.

const medicacionDeHoy: Herramienta<Record<string, never>> = {
  especificacion: {
    nombre: 'medicacion_de_hoy',
    descripcion: 'Los remedios de hoy de la persona: hora, nombre, para qué son y si ya los confirmó. Para conversar de su rutina, no para dar indicaciones.',
    esquemaEntrada: { type: 'object', properties: {} },
  },
  entrada: z.object({}) as unknown as z.ZodType<Record<string, never>>,
  async ejecutar(a) {
    const { desde, hasta } = await diaLocal(a.bd, a.personaId, a.ahora());
    const dosis = await dosisEntre(a.bd, a.cifrador, a.personaId, desde, hasta);
    return { remedios: dosis.map((x) => ({ evento_id: x.eventoId, hora: x.hora, nombre: x.nombre, para_que: x.propositoSimple, estado: x.estado })) };
  },
};

const medicacionConfirmar: Herramienta<{ evento_ids?: string[] | undefined }> = {
  especificacion: {
    nombre: 'medicacion_confirmar_dosis',
    descripcion:
      'Registra que la persona se tomó sus remedios, cuando ella lo dice ("ya me la tomé"). Sin evento_ids, confirma los de la hora más cercana. No la uses si no lo dijo con claridad.',
    esquemaEntrada: { type: 'object', properties: { evento_ids: { type: 'array', items: { type: 'string' } } } },
  },
  entrada: z.object({ evento_ids: z.array(idHecho).max(20).optional() }),
  async ejecutar(a, e) {
    const confirmadas = await confirmarDosis(a.bd, a.personaId, { ...(e.evento_ids?.length ? { eventoIds: e.evento_ids } : {}), ahora: a.ahora(), origen: 'voz' });
    return confirmadas.length ? { confirmadas: confirmadas.length } : { confirmadas: 0, nota: 'No había remedios pendientes cerca de esta hora.' };
  },
};

const medicacionNoTomada: Herramienta<{ evento_ids: string[]; motivo?: string | undefined }> = {
  especificacion: {
    nombre: 'medicacion_no_tomada',
    descripcion:
      'Registra que la persona dice que NO se tomó o no se tomará un remedio, con su motivo en sus palabras. No insistas ni la hagas sentir culpable: ofrece anotar la duda para su control con control_anotar_pregunta.',
    esquemaEntrada: { type: 'object', properties: { evento_ids: { type: 'array', items: { type: 'string' } }, motivo: { type: 'string' } }, required: ['evento_ids'] },
  },
  entrada: z.object({ evento_ids: z.array(idHecho).min(1).max(20), motivo: z.string().max(300).optional() }),
  async ejecutar(a, e) {
    const r = await registrarOmision(a.bd, a.cifrador, a.personaId, { eventoIds: e.evento_ids, motivo: e.motivo ?? null, ahora: a.ahora() });
    return { registradas: r.length };
  },
};

const citasProximasH: Herramienta<Record<string, never>> = {
  especificacion: {
    nombre: 'citas_proximas',
    descripcion: 'Los controles y citas de salud de la persona en las próximas semanas.',
    esquemaEntrada: { type: 'object', properties: {} },
  },
  entrada: z.object({}) as unknown as z.ZodType<Record<string, never>>,
  async ejecutar(a) {
    const citas = await citasProximas(a.bd, a.cifrador, a.personaId, a.ahora(), 45);
    const fmt = new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    return { citas: citas.map((c) => ({ cuando: fmt.format(c.fecha), lugar: c.lugar, profesional: c.profesional })) };
  },
};

const controlAnotarPregunta: Herramienta<{ texto: string }> = {
  especificacion: {
    nombre: 'control_anotar_pregunta',
    descripcion:
      'Anota una pregunta o duda de la persona para su próximo control de salud, con sus palabras. Úsala cuando pregunte algo que debe decidir su médico o la enfermera (dosis, síntomas, remedios olvidados). Después cuéntale que quedó anotada.',
    esquemaEntrada: { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'] },
  },
  entrada: z.object({ texto: z.string().trim().min(3).max(400) }),
  async ejecutar(a, e) {
    await anotarPregunta(a.bd, a.cifrador, a.personaId, e.texto, a.turnoPersonaId, a.ahora());
    return { anotada: true };
  },
};

export const HERRAMIENTAS = [
  memoriaBuscar,
  memoriaQueRecuerdo,
  memoriaGuardarHecho,
  memoriaCorregir,
  memoriaConfirmar,
  memoriaOlvidar,
  memoriaPrivado,
  medicacionDeHoy,
  medicacionConfirmar,
  medicacionNoTomada,
  citasProximasH,
  controlAnotarPregunta,
  riesgoReportar,
] as const;

export const ESPECIFICACIONES: EspecificacionHerramienta[] = HERRAMIENTAS.map((h) => h.especificacion);

export async function ejecutarHerramienta(a: AmbitoHerramienta, nombre: string, entrada: unknown): Promise<unknown> {
  const h = HERRAMIENTAS.find((x) => x.especificacion.nombre === nombre) as Herramienta<unknown> | undefined;
  if (!h) return { error: `Herramienta desconocida: ${nombre}` };
  const v = h.entrada.safeParse(entrada ?? {});
  if (!v.success) return { error: `Entrada inválida: ${v.error.issues.map((i) => i.message).join('; ')}` };
  return h.ejecutar(a, v.data);
}
