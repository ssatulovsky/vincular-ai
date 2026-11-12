import { ErrorProveedor, type MensajeModelo, type ModelosPorTarea } from '@vincular/ia';
import {
  detectarRiesgoPorReglas,
  indicacionesDeRegeneracion,
  nivelMayor,
  recordatorioEmergencia,
  respuestaSeguraPara,
  respuestaSinServicio,
  type ContactosEmergencia,
  type NivelRiesgo,
} from '@vincular/seguridad-clinica';
import type { Bd } from '../db/conexion.ts';
import type { Cifrador } from '../seguridad/cifrado.ts';
import { clasificarRiesgo, type ResultadoClasificador } from './clasificadorRiesgo.ts';
import { revisarRespuesta } from './guardian.ts';
import { ESPECIFICACIONES, ejecutarHerramienta } from './herramientas.ts';
import { construirInstrucciones, correccionParaRegenerar } from './instrucciones.ts';
import { llamarModelo, type AmbitoUso } from './llamadas.ts';
import { planVigente, umbralesDelPlan, type PlanTerapeutico } from './plan.ts';
import { contextoPersona, insertarTurno, leerSesion, turnosDeSesion, type ContextoPersona, type OrigenTurno } from './repositorio.ts';

export interface DependenciasOrquestador {
  bd: Bd;
  cifrador: Cifrador;
  modelos: ModelosPorTarea;
  emergencia: ContactosEmergencia;
  esperaClasificadorMs: number;
  ahora?: () => Date;
}

export interface ResultadoTurno {
  turnoId: string;
  respuesta: string;
  origen: OrigenTurno;
  nivel: NivelRiesgo;
  modoEmergencia: boolean;
}

export class ErrorConversacion extends Error {
  constructor(
    mensaje: string,
    readonly estado: number,
  ) {
    super(mensaje);
    this.name = 'ErrorConversacion';
  }
}

const MAX_PASOS_HERRAMIENTAS = 4;
const MAX_CARACTERES_TURNO = 4000;
const CATEGORIAS_MEDICAS = ['dolor_toracico', 'signos_acv', 'dificultad_respiratoria', 'caida_con_lesion'];

interface EstadoTurno {
  sesionId: string;
  personaId: string;
  turnoPersonaId: string;
  texto: string;
  ctx: ContextoPersona;
  plan: PlanTerapeutico | null;
  historial: Array<{ hablante: 'persona' | 'agente'; texto: string }>;
  ambito: AmbitoUso;
  reporteAgente: { nivel: NivelRiesgo; motivo: string } | null;
}

/**
 * Bucle conversacional. Un solo personaje hacia la persona; los "especialistas" son
 * herramientas e instrucciones dentro de este mismo bucle.
 *
 * Garantías (cubiertas por pruebas):
 *   - El detector de riesgo por reglas corre sobre CADA turno de la persona, antes de generar.
 *   - El clasificador de riesgo corre EN PARALELO a la generación y solo puede subir el nivel.
 *   - Ninguna respuesta del modelo sale sin pasar por el guardián. Si falla dos veces, o si el
 *     proveedor o el guardián no responden, sale una respuesta segura predefinida.
 *   - En nivel 3 el agente no cierra la conversación; la sesión queda en modo emergencia.
 *   - Todo evento de nivel 2 y 3 queda registrado con el fragmento literal (cifrado).
 */
export class Orquestador {
  private readonly colas = new Map<string, Promise<unknown>>();

  constructor(private readonly d: DependenciasOrquestador) {}

  /** Los turnos de una misma sesión se procesan de a uno, en orden de llegada. */
  procesarTurno(sesionId: string, personaId: string, texto: string): Promise<ResultadoTurno> {
    const previo = this.colas.get(sesionId) ?? Promise.resolve();
    const actual = previo.catch(() => undefined).then(() => this.procesar(sesionId, personaId, texto));
    this.colas.set(sesionId, actual);
    void actual.finally(() => {
      if (this.colas.get(sesionId) === actual) this.colas.delete(sesionId);
    }).catch(() => undefined);
    return actual;
  }

  private async procesar(sesionId: string, personaId: string, textoCrudo: string): Promise<ResultadoTurno> {
    const { bd, cifrador } = this.d;
    const texto = textoCrudo.trim();
    if (texto.length === 0) throw new ErrorConversacion('El mensaje está vacío', 400);
    if (texto.length > MAX_CARACTERES_TURNO) throw new ErrorConversacion('El mensaje es demasiado largo', 400);

    const sesion = await leerSesion(bd, sesionId);
    if (!sesion || sesion.personaId !== personaId) throw new ErrorConversacion('Sesión inexistente', 404);
    if (sesion.fin) throw new ErrorConversacion('La sesión está cerrada', 409);

    const turnoPersonaId = await insertarTurno(bd, cifrador, sesionId, personaId, 'persona', texto, 'persona');
    const [ctx, planV, turnos] = await Promise.all([
      contextoPersona(bd, cifrador, personaId),
      planVigente(bd, cifrador, personaId),
      turnosDeSesion(bd, cifrador, sesionId),
    ]);
    const plan = planV?.contenido ?? null;
    const e: EstadoTurno = {
      sesionId,
      personaId,
      turnoPersonaId,
      texto,
      ctx,
      plan,
      historial: turnos.filter((t) => t.id !== turnoPersonaId).map((t) => ({ hablante: t.hablante, texto: t.texto })),
      ambito: { personaId, sesionId },
      reporteAgente: null,
    };

    // 1. Reglas: síncronas, antes de generar.
    const reglas = detectarRiesgoPorReglas(texto, { umbralesPersonales: umbralesDelPlan(plan) });
    const categoriasReglas: string[] = [...new Set(reglas.hallazgos.map((h) => h.categoria))];

    // 2. Clasificador en paralelo.
    const clasificacion = clasificarRiesgo(bd, this.d.modelos, e.ambito, texto, e.historial);

    let modoEmergencia = sesion.modoEmergencia;
    let categoriasEmergencia = sesion.categoriasEmergencia;
    let nivel: NivelRiesgo = reglas.nivel;
    let categorias = categoriasReglas;
    let clasif: ResultadoClasificador | null = null;
    let respuesta: { texto: string; origen: OrigenTurno };
    let entroEnEmergencia = false;

    if (reglas.nivel === 3 && !modoEmergencia) {
      // Emergencia por reglas: no se espera al modelo. Respuesta del protocolo, al instante.
      modoEmergencia = true;
      entroEnEmergencia = true;
      categoriasEmergencia = categorias;
      respuesta = { texto: respuestaSeguraPara(3, categorias, this.d.emergencia, ctx.perfil.trato), origen: 'protocolo_emergencia' };
      void clasificacion.catch(() => undefined);
    } else {
      respuesta = await this.generarConGuardian(e, nivel, categorias, modoEmergencia, categoriasEmergencia);
      clasif = await conPlazo(clasificacion, this.d.esperaClasificadorMs);
      const nivelFinal = nivelMayor(reglas.nivel, clasif?.nivel, e.reporteAgente?.nivel);
      categorias = [...new Set([...categoriasReglas, ...(clasif && clasif.nivel > reglas.nivel ? clasif.categorias : [])])];

      if (nivelFinal === 3 && !modoEmergencia) {
        // El clasificador o el propio agente subieron a emergencia: se descarta lo generado.
        modoEmergencia = true;
        entroEnEmergencia = true;
        categoriasEmergencia = categorias;
        respuesta = { texto: respuestaSeguraPara(3, categorias, this.d.emergencia, ctx.perfil.trato), origen: 'protocolo_emergencia' };
      } else if (nivelFinal === 2 && nivel < 2 && !modoEmergencia) {
        // Subió a alerta después de generar: se genera de nuevo con las indicaciones de nivel 2.
        respuesta = await this.generarConGuardian(e, 2, categorias, false, []);
      }
      nivel = nivelFinal;
    }

    if (modoEmergencia && !entroEnEmergencia && respuesta.origen !== 'protocolo_emergencia') {
      respuesta = { ...respuesta, texto: `${respuesta.texto} ${recordatorioEmergencia(categoriasEmergencia, this.d.emergencia, ctx.perfil.trato)}` };
    }

    await this.registrarRiesgo(e, nivel, categorias, reglas.hallazgos.map((h) => h.reglaId), clasif, entroEnEmergencia, reglas.nivel);
    await bd.query(
      `UPDATE sesion_conversacion SET nivel_maximo = greatest(nivel_maximo, $2), modo_emergencia = $3, categorias_emergencia = $4 WHERE id = $1`,
      [sesionId, nivel, modoEmergencia, categoriasEmergencia],
    );
    const turnoId = await insertarTurno(bd, cifrador, sesionId, personaId, 'agente', respuesta.texto, respuesta.origen);
    return { turnoId, respuesta: respuesta.texto, origen: respuesta.origen, nivel, modoEmergencia };
  }

  /** Genera con el modelo y pasa por el guardián; un reintento; si no, respuesta segura. */
  private async generarConGuardian(
    e: EstadoTurno,
    nivel: NivelRiesgo,
    categorias: string[],
    modoEmergencia: boolean,
    categoriasEmergencia: string[],
  ): Promise<{ texto: string; origen: OrigenTurno }> {
    const trato = e.ctx.perfil.trato;
    const nivelEfectivo: NivelRiesgo = modoEmergencia ? 3 : nivel;
    const categoriasEfectivas = modoEmergencia ? categoriasEmergencia : categorias;
    const segura = (proveedorCaido: boolean): { texto: string; origen: OrigenTurno } => {
      if (modoEmergencia) return { texto: respuestaSeguraPara(3, categoriasEmergencia, this.d.emergencia, trato), origen: 'protocolo_emergencia' };
      if (proveedorCaido && nivelEfectivo === 0) return { texto: respuestaSinServicio(trato), origen: 'respuesta_segura' };
      return { texto: respuestaSeguraPara(nivelEfectivo, categoriasEfectivas, this.d.emergencia, trato), origen: 'respuesta_segura' };
    };

    const instrucciones = construirInstrucciones({
      perfil: e.ctx.perfil,
      nombrePersona: e.ctx.nombre,
      plan: e.plan,
      preferencias: e.ctx.hechos.filter((h) => h.capa === 'preferencias').map((h) => h.contenido),
      hechos: e.ctx.hechos.filter((h) => h.capa !== 'preferencias').map((h) => h.contenido),
      nivelRiesgo: nivelEfectivo,
      categoriasRiesgo: categoriasEfectivas,
      modoEmergencia,
      ahora: this.d.ahora?.() ?? new Date(),
    });

    let correccion = '';
    for (let intento = 1; intento <= 2; intento++) {
      let texto: string;
      try {
        texto = await this.generar(e, instrucciones + correccion);
      } catch (error) {
        await this.registrarIntervencion(e, intento, 'proveedor', ['proveedor_no_disponible'], [error instanceof ErrorProveedor ? 'proveedor.error' : 'generacion.error'], null, 'respuesta_segura');
        return segura(true);
      }
      const rev = await revisarRespuesta(this.d.bd, this.d.modelos, e.ambito, texto, {
        terminosProhibidos: e.plan?.no_mencionar ?? [],
        mensajePersona: e.texto,
        nivelRiesgo: modoEmergencia ? 0 : nivelEfectivo,
      });
      if (rev.aprobada) return { texto, origen: intento === 1 ? 'modelo' : 'modelo_regenerado' };

      const ultimo = intento === 2 || rev.etapa === 'proveedor';
      await this.registrarIntervencion(
        e,
        intento,
        rev.etapa ?? 'reglas',
        [...new Set(rev.problemas.map((p) => p.categoria))],
        rev.problemas.map((p) => p.reglaId),
        texto,
        ultimo ? 'respuesta_segura' : 'regenerar',
      );
      // Si el guardián no está disponible, regenerar no ayuda: se falla cerrado.
      if (ultimo) return segura(rev.etapa === 'proveedor');
      correccion = correccionParaRegenerar(indicacionesDeRegeneracion(rev.problemas));
    }
    return segura(false);
  }

  /** Llamada al modelo de conversación con el bucle de herramientas. */
  private async generar(e: EstadoTurno, instrucciones: string): Promise<string> {
    const mensajes: MensajeModelo[] = e.historial.map((t) => (t.hablante === 'persona' ? { rol: 'usuario', texto: t.texto } : { rol: 'asistente', texto: t.texto }));
    if (mensajes[0]?.rol === 'asistente') mensajes.unshift({ rol: 'usuario', texto: '(La conversación la inició el compañero.)' });
    mensajes.push({ rol: 'usuario', texto: e.texto });

    const ambitoHerramientas = {
      bd: this.d.bd,
      cifrador: this.d.cifrador,
      personaId: e.personaId,
      turnoPersonaId: e.turnoPersonaId,
      alReportarRiesgo: (nivel: NivelRiesgo, motivo: string) => {
        if (!e.reporteAgente || nivel > e.reporteAgente.nivel) e.reporteAgente = { nivel, motivo };
      },
    };

    for (let paso = 0; paso <= MAX_PASOS_HERRAMIENTAS; paso++) {
      const r = await llamarModelo(this.d.bd, this.d.modelos, 'conversacion', e.ambito, {
        instrucciones,
        mensajes,
        herramientas: ESPECIFICACIONES,
        maxTokens: 600,
      });
      if (r.tipo === 'texto') {
        if (!r.texto.trim()) throw new Error('El modelo respondió vacío');
        return r.texto.trim();
      }
      mensajes.push({ rol: 'asistente', ...(r.texto ? { texto: r.texto } : {}), llamadas: r.llamadas });
      for (const l of r.llamadas) {
        const resultado = await ejecutarHerramienta(ambitoHerramientas, l.nombre, l.entrada).catch((err: Error) => ({ error: err.message }));
        mensajes.push({ rol: 'herramienta', llamadaId: l.id, nombre: l.nombre, resultado });
      }
    }
    throw new Error('El modelo superó el máximo de pasos con herramientas');
  }

  private async registrarIntervencion(
    e: EstadoTurno,
    intento: number,
    etapa: 'reglas' | 'clasificador' | 'proveedor',
    categorias: string[],
    reglas: string[],
    textoRechazado: string | null,
    accion: 'regenerar' | 'respuesta_segura',
  ): Promise<void> {
    await this.d.bd.query(
      `INSERT INTO intervencion_guardian (persona_id, sesion_id, turno_persona_id, intento, etapa, categorias, reglas, texto_rechazado_cifrado, accion)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [e.personaId, e.sesionId, e.turnoPersonaId, intento, etapa, categorias, reglas, textoRechazado === null ? null : this.d.cifrador.cifrar(textoRechazado), accion],
    );
  }

  private async registrarRiesgo(
    e: EstadoTurno,
    nivel: NivelRiesgo,
    categorias: string[],
    reglasIds: string[],
    clasif: ResultadoClasificador | null,
    entroEnEmergencia: boolean,
    nivelReglas: NivelRiesgo,
  ): Promise<void> {
    if (nivel === 0) return;
    // Nivel 1 y superiores alimentan las señales (tendencias); el Sprint 5 sube a nivel 1 con ≥ 2 días.
    for (const cat of categorias.length ? categorias : ['sin_categoria']) {
      await this.d.bd.query('INSERT INTO senal (persona_id, tipo, valor, origen_turno_id) VALUES ($1, $2, $3, $4)', [e.personaId, `riesgo.${cat}`, nivel, e.turnoPersonaId]);
    }
    if (nivel < 2) return;

    const fuente =
      nivelReglas === nivel
        ? reglasIds.some((id) => id.startsWith('personal.')) && !reglasIds.some((id) => !id.startsWith('personal.'))
          ? 'umbral_personal'
          : 'reglas'
        : clasif && clasif.nivel === nivel
          ? 'clasificador'
          : 'agente';
    const medica = categorias.some((c) => CATEGORIAS_MEDICAS.includes(c));
    // TODO(Sprint 5): notificaciones push, SMS y llamada; cadena de contactos y plazo de acuse.
    // Mientras tanto el evento queda en la bandeja de alertas del panel clínico y de la guardia.
    const accion =
      nivel === 3
        ? `${entroEnEmergencia ? 'protocolo_emergencia' : 'emergencia_en_curso'}:${medica ? 'samu' : 'crisis'};bandeja_alertas`
        : 'aviso_agente;bandeja_alertas';
    await this.d.bd.query(
      `INSERT INTO evento_riesgo (persona_id, sesion_id, evidencia_turno_ids, nivel, nivel_reglas, nivel_clasificador, fuente, categorias, detalle, fragmento_cifrado, accion, acuse_requerido)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)`,
      [
        e.personaId,
        e.sesionId,
        [e.turnoPersonaId],
        nivel,
        nivelReglas,
        clasif?.nivel ?? null,
        fuente,
        categorias,
        {
          reglas: reglasIds,
          clasificador: clasif ? { nivel: clasif.nivel, categorias: clasif.categorias, razon: clasif.razon } : null,
          agente: e.reporteAgente,
        },
        this.d.cifrador.cifrar(e.texto),
        accion,
      ],
    );
  }
}

async function conPlazo<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let temporizador: NodeJS.Timeout | undefined;
  const plazo = new Promise<null>((resolve) => {
    temporizador = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([p, plazo]);
  } finally {
    clearTimeout(temporizador);
  }
}
