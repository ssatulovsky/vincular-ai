import type { NivelRiesgo } from '../niveles.ts';

/**
 * Reglas del detector de riesgo sobre el turno de la persona (texto normalizado).
 *
 * TODO(clinico): todo este catálogo es un PRIMER BORRADOR técnico, conservador a propósito.
 * El equipo clínico debe revisar cada regla, su nivel y su categoría, y ampliar el conjunto
 * de casos en `casos/riesgo.casos.json`. Ninguna regla se elimina ni se baja de nivel sin
 * esa revisión y sin que el conjunto de casos siga pasando al 100 % en los casos críticos.
 *
 * Criterio aplicado mientras tanto: ante la duda, el nivel más alto. Los falsos positivos se
 * calibran en el piloto; los falsos negativos no se aceptan.
 */

export type CategoriaRiesgo =
  | 'ideacion_suicida'
  | 'desesperanza_carga'
  | 'dolor_toracico'
  | 'signos_acv'
  | 'dificultad_respiratoria'
  | 'caida_con_lesion'
  | 'caida'
  | 'desorientacion'
  | 'estafa'
  | 'rechazo_medicacion'
  | 'maltrato'
  | 'animo_bajo'
  | 'sueno'
  | 'apetito'
  | 'aislamiento'
  | 'dosis_olvidada'
  | 'umbral_personal';

export interface ReglaRiesgo {
  id: string;
  categoria: CategoriaRiesgo;
  nivel: NivelRiesgo;
  tipo: 'explicito' | 'indirecto';
  /** Se aplica sobre el texto normalizado (ver `normalizar`). */
  patron: RegExp;
  /**
   * Si la coincidencia va precedida de "no" ("no me quiero morir"), el nivel baja a este valor
   * en vez de desaparecer. Nunca baja a 0: una negación sobre la muerte sigue siendo un tema.
   */
  nivelSiNegado?: NivelRiesgo;
}

/**
 * Modismos que contienen palabras de las reglas pero no indican riesgo ("me muero de la risa",
 * "me caí del catre"). Se neutralizan antes de aplicar las reglas.
 * TODO(clinico): revisar que ninguno oculte un riesgo real.
 */
export const MODISMOS_NEUTROS: readonly RegExp[] = [
  /\b(me muero|me estoy muriendo|me moria|me mori) de (la )?(risa|hambre|sueno|frio|calor|ganas|verguenza|curiosidad|aburrimiento|sed)\b/g,
  /\b(muerto|muerta|muertos|muertas) de (la )?(risa|hambre|cansancio|sueno|frio|calor|sed|verguenza|susto)\b/g,
  /\b(me cai|me caigo|me cayo) (del catre|de la risa|de espaldas de la risa)\b/g,
  /\bme (mato|mate|estoy matando) (trabajando|estudiando|de la risa|limpiando|cocinando)\b/g,
  /\b(se murio|se me murio|murio) (la bateria|el celular|el telefono|la tele|la radio|la planta)\b/g,
];

const R = (
  id: string,
  categoria: CategoriaRiesgo,
  nivel: NivelRiesgo,
  tipo: ReglaRiesgo['tipo'],
  patron: RegExp,
  nivelSiNegado?: NivelRiesgo,
): ReglaRiesgo => (nivelSiNegado === undefined ? { id, categoria, nivel, tipo, patron } : { id, categoria, nivel, tipo, patron, nivelSiNegado });

const PERSONA_CERCANA = '(el|ella|mi (esposo|esposa|marido|senora|viejo|vieja|vieji?to|vieji?ta|hijo|hija|mama|papa|hermano|hermana|compadre|comadre))';
const MEDICAMENTOS = '(pastillas?|remedios?|medicamentos?|medicinas?|tabletas?|capsulas?)';

export const REGLAS_RIESGO: readonly ReglaRiesgo[] = [
  // ── Nivel 3: ideación o plan suicida ─────────────────────────────────────────────
  R('ideacion.quiero_morir', 'ideacion_suicida', 3, 'explicito', /\b(me quiero|quiero|me queria|queria|me quisiera|quisiera) (morir|morirme|matarme|suicidarme)\b/, 2),
  R('ideacion.voy_a_matarme', 'ideacion_suicida', 3, 'explicito', /\b(voy a|me voy a|pienso|estoy pensando en|he pensado en|pense en) (matarme|suicidarme|quitarme la vida|acabar con (todo|mi vida)|terminar con (todo|mi vida))\b/, 2),
  R('ideacion.quitarme_la_vida', 'ideacion_suicida', 3, 'explicito', /\b(quitarme la vida|acabar con mi vida|terminar con mi vida|poner fin a mi vida|matarme)\b/, 2),
  R('ideacion.no_quiero_vivir', 'ideacion_suicida', 3, 'indirecto', /\bya no (quiero|deseo) (vivir|seguir viviendo|estar aqui|estar en este mundo|seguir aqui|seguir)\b/),
  R('ideacion.no_quiero_vivir_2', 'ideacion_suicida', 3, 'indirecto', /\bno quiero (vivir|seguir viviendo) (mas|ya)\b/),
  R('ideacion.para_que_seguir', 'ideacion_suicida', 3, 'indirecto', /\bpara que (seguir|sigo|vivir|vivo|seguir viviendo|despertar)\b/),
  R('ideacion.mejor_muerto', 'ideacion_suicida', 3, 'indirecto', /\bmejor (me muero|me muera|morirme|estar muert[oa]|estaria muert[oa]|no despertar)\b/),
  R('ideacion.ojala_morir', 'ideacion_suicida', 3, 'indirecto', /\bojala (me muera|me muriera|no despierte|no despertar|no despertara|me lleve dios|dios me lleve|diosito me lleve|me llevara)\b/),
  R('ideacion.dios_me_lleve', 'ideacion_suicida', 3, 'indirecto', /\b(que )?(dios|diosito|tata dios|el senor|la virgen|la muerte)( que)? me (lleve|llevara|recoja|recogiera|venga a buscar|llame)\b/),
  R('ideacion.no_vale_la_pena', 'ideacion_suicida', 3, 'indirecto', /\bno (vale|tiene sentido) (la pena )?(seguir|vivir|seguir viviendo)\b/),
  R('ideacion.no_tengo_para_que_vivir', 'ideacion_suicida', 3, 'indirecto', /\bno tengo (por|para) (que|quien) vivir\b/),
  R('ideacion.mejor_sin_mi', 'ideacion_suicida', 3, 'indirecto', /\b(estarian|estarias|estaria|estan) mejor sin mi\b/),
  R('ideacion.nadie_notaria', 'ideacion_suicida', 3, 'indirecto', /\bnadie (se daria cuenta|notaria|me echaria de menos) si (me muero|me muriera|muero|no estoy|no estuviera|desaparezco|desapareciera)\b/),
  R('ideacion.reunirme_difunto', 'ideacion_suicida', 3, 'indirecto', /\b(quiero|quisiera|me quiero) (ir|irme|reunirme|juntarme|estar) con (mi (difunt[oa]|finad[oa])|el en el cielo|ella en el cielo)\b/),
  R('ideacion.metodo_medicamentos', 'ideacion_suicida', 3, 'indirecto', new RegExp(`\\b${MEDICAMENTOS}\\b.{0,40}\\b(no despertar|no despertarme|acabar con|terminar con|morirme|morir|dormir para siempre)\\b`)),
  R('ideacion.metodo_lanzarse', 'ideacion_suicida', 3, 'indirecto', /\b(tirarme|lanzarme|botarme) (al|del|desde el|desde la|por la|a la|de la|del puente|al metro|al rio)\b/),
  R('ideacion.dormir_para_siempre', 'ideacion_suicida', 3, 'indirecto', /\b(dormirme|dormir|quedarme dormid[oa]) (y no despertar|para siempre)\b/),

  // ── Nivel 2: menciones ambiguas de muerte, desesperanza y sensación de ser una carga ──
  // TODO(clinico): la especificación cita "soy una carga", "estoy de más", "ya no sirvo para
  // nada" y "quiero reunirme con él" como frases indirectas. Quedan en nivel 2 (aviso a cuidador
  // y supervisor < 4 h) y el clasificador puede subirlas a 3. Ratificar.
  R('ambiguo.reunirme_con_el', 'ideacion_suicida', 2, 'indirecto', new RegExp(`\\b(quiero|quisiera|me quiero) (ir|irme|reunirme|juntarme) con ${PERSONA_CERCANA}\\b`)),
  R('ambiguo.mencion_suicidio', 'ideacion_suicida', 2, 'indirecto', /\b(suicid\w*|matarse|quitarse la vida)\b/),
  R('ambiguo.cansada_de_vivir', 'ideacion_suicida', 2, 'indirecto', /\b(cansad[oa]|aburrid[oa]|harto|harta) de (vivir|la vida|esta vida|estar viv[oa])\b/),
  R('ambiguo.ya_me_quiero_ir', 'ideacion_suicida', 2, 'indirecto', /\b(ya me quiero ir|ya es hora de irme|me quiero ir de este mundo|ya cumpli mi tiempo|ya estoy de salida)\b/),
  R('carga.no_sirvo', 'desesperanza_carga', 2, 'indirecto', /\b(ya )?no sirvo (para|ni para) nada\b/),
  R('carga.estoy_de_mas', 'desesperanza_carga', 2, 'indirecto', /\b(estoy de mas|aqui sobro|yo sobro|sobro en|soy un mueble)\b/),
  R('carga.soy_una_carga', 'desesperanza_carga', 2, 'indirecto', /\bsoy (una|un) (carga|estorbo|cacho|molestia|problema) (para|pa)?\b|\bsoy (una|un) (carga|estorbo|cacho)\b/),
  R('carga.solo_molesto', 'desesperanza_carga', 2, 'indirecto', /\b(solo|nada mas) (molesto|estorbo|doy problemas|doy trabajo|les doy trabajo)\b/),
  R('carga.nadie_me_necesita', 'desesperanza_carga', 2, 'indirecto', /\bnadie me (necesita|quiere|echaria de menos|va a extranar|extranaria)\b/),
  R('carga.ya_no_aguanto', 'desesperanza_carga', 2, 'indirecto', /\b(ya no (aguanto|soporto|puedo) mas)\b/),
  R('carga.sin_esperanza', 'desesperanza_carga', 2, 'indirecto', /\b(no hay|ya no hay|no tengo) (esperanza|salida|futuro)\b|\bnada va a mejorar\b/),

  // ── Nivel 3: emergencias médicas ──────────────────────────────────────────────────
  // TODO(clinico): revisar con la enfermera de enlace las formas en que las personas mayores
  // describen estos síntomas en la comuna del piloto.
  R('medico.dolor_pecho', 'dolor_toracico', 3, 'explicito', /\b(dolor|duele|doliendo|aprieta|apretado|apretada|presion|opresion|puntada|puntadas|ardor|peso)\b.{0,25}\bpecho\b|\bpecho\b.{0,25}\b(duele|doliendo|dolor|aprieta|apretado|apretada|presion|opresion|puntada|apreta)\b/),
  R('medico.dolor_brazo_izq', 'dolor_toracico', 3, 'explicito', /\b(dolor|duele|adormecido|hormigueo)\b.{0,25}\bbrazo izquierdo\b/),
  R('medico.acv_no_mover', 'signos_acv', 3, 'explicito', /\bno (puedo|me puedo|logro) mover (el|la|mi|un|medio) (brazo|pierna|mano|lado|cuerpo|cara)\b/),
  R('medico.acv_cara', 'signos_acv', 3, 'explicito', /\bse me (durmio|adormecio|tuercio|torcio|cayo|chueco|paralizo) (la|el|media|un lado de la) (cara|boca|brazo|lado|mano|pierna)\b/),
  R('medico.acv_habla', 'signos_acv', 3, 'explicito', /\b(hablo|estoy hablando|me sale la voz) (raro|rara|enredado|traposo|traposa|chueco)\b|\bno me salen las palabras\b|\bse me traba la lengua\b/),
  R('medico.acv_vista', 'signos_acv', 3, 'explicito', /\b(veo doble|perdi la vista|no veo de un ojo|se me nublo la vista de repente)\b/),
  R('medico.respirar', 'dificultad_respiratoria', 3, 'explicito', /\b(no puedo respirar|me falta el aire|me ahogo|me estoy ahogando|no me entra el aire)\b/),
  R('medico.caida_lesion', 'caida_con_lesion', 3, 'explicito', /\b(me cai|me fui al suelo|me cai al suelo|me resbale|me tropece)\b.{0,50}\b(no me puedo (parar|levantar)|no puedo (pararme|levantarme|mover)|sangr\w*|me quebre|me fracture|me pegue en la cabeza|me rompi|me duele mucho)\b/),
  R('medico.en_el_suelo', 'caida_con_lesion', 3, 'explicito', /\b(estoy en el suelo|estoy tirad[oa] en el suelo|no me puedo (parar|levantar) del suelo)\b/),

  // ── Nivel 2: alertas ─────────────────────────────────────────────────────────────
  R('caida.sin_lesion', 'caida', 2, 'explicito', /\b(me cai|me fui al suelo|sufri una caida|me tropece y me cai|me resbale y me cai|tuve una caida)\b/),
  R('desorientacion.donde_estoy', 'desorientacion', 2, 'explicito', /\bno (se|reconozco) (donde estoy|en que lugar estoy|esta casa|mi casa|este lugar)\b/),
  R('desorientacion.tiempo', 'desorientacion', 2, 'indirecto', /\bno se (que dia|en que ano|que ano|en que mes) (es|estamos)\b/),
  R('desorientacion.perdido', 'desorientacion', 2, 'explicito', /\bme perdi (volviendo|camino|en la calle|en el barrio|en la feria)\b|\bno me acuerdo como (llegar|volver) a (mi casa|la casa)\b/),
  R('estafa.llamada', 'estafa', 2, 'explicito', /\b(me|nos) (llamaron|llamo|escribieron|escribio|mandaron un mensaje)\b.{0,60}\b(banco|carabineros|fiscalia|pdi|detenido|accidente|premio|ganador|clave|cuenta|tarjeta|transferencia|abogado)\b/),
  R('estafa.clave', 'estafa', 2, 'explicito', /\b(me pidieron|me piden|me pidio|le di|les di) (la |mi |el )?(clave|contrasena|tarjeta|coordenadas|codigo|numero de la tarjeta|pin)\b/),
  R('estafa.deposito', 'estafa', 2, 'explicito', /\b(tengo que|tuve que|debo|me pidieron) (depositar|transferir|pagar|mandar plata|juntar plata)\b.{0,60}\b(nieto|nieta|hijo|hija|sobrino|premio|carabineros|abogado|fianza|multa|detenido)\b/),
  R('estafa.detenido', 'estafa', 2, 'explicito', /\b(nieto|nieta|hijo|hija|sobrino|sobrina) (esta|quedo|esta quedando) (detenido|detenida|preso|presa)\b/),
  R('estafa.premio', 'estafa', 2, 'explicito', /\bme (gane|saque) (un|el) (premio|auto|sorteo)\b/),
  R('medicacion.rechazo', 'rechazo_medicacion', 2, 'explicito', new RegExp(`\\bno (me voy a|voy a|quiero|pienso) tomar(me)? (mas )?(las |los |mis |el |la )?${MEDICAMENTOS}\\b`)),
  R('medicacion.deje', 'rechazo_medicacion', 2, 'explicito', new RegExp(`\\b(deje|he dejado|voy a dejar) (de tomar|los|las) (las |los |mis )?${MEDICAMENTOS}\\b`)),
  R('medicacion.bote', 'rechazo_medicacion', 2, 'explicito', new RegExp(`\\b(bote|tire|escondi) (las|los|mis) ${MEDICAMENTOS}\\b`)),
  // TODO(clinico): el maltrato hacia personas mayores no está en la tabla de la sección 6.
  // Se deja en nivel 2 hasta que el equipo clínico defina el protocolo.
  R('maltrato.fisico', 'maltrato', 2, 'explicito', /\b(me pega|me pegan|me pego|me golpea|me golpean|me golpeo|me empuja|me empujo|me encierra|me encierran|me amarra)\b/),
  R('maltrato.economico', 'maltrato', 2, 'explicito', /\b(me quita|me quitan|me quito|se queda con|se quedan con) (la|mi) (plata|pension|jubilacion|tarjeta)\b/),

  // ── Nivel 1: atención (se acumulan como señales; dos días seguidos sube en el Sprint 5) ──
  R('animo.triste', 'animo_bajo', 1, 'explicito', /\b(estoy|me siento|ando|amaneci) (muy )?(triste|bajonead[oa]|deprimid[oa]|decaid[oa]|sin animo|desanimad[oa]|angustiad[oa]|apenad[oa])\b/),
  R('animo.sin_ganas', 'animo_bajo', 1, 'explicito', /\bno tengo ganas de nada\b|\bnada me da gusto\b|\bme lo paso llorando\b|\bllore (todo el dia|toda la noche|mucho)\b/),
  R('sueno.mal', 'sueno', 1, 'explicito', /\bno (pude|he podido|puedo) dormir\b|\bdormi (mal|poco|pesimo|nada)\b|\bme despierto (a cada rato|en la noche|muy temprano)\b|\bpase la noche en vela\b/),
  R('apetito.bajo', 'apetito', 1, 'explicito', /\bno (tengo|me da) hambre\b|\bno (he|e) comido\b|\bse me (quito|fue) el apetito\b|\bno (almorce|tome once|tome desayuno|comi nada)\b/),
  R('aislamiento.nadie', 'aislamiento', 1, 'explicito', /\bnadie me (llama|visita|habla|viene a ver)\b|\bno (he|e) (visto|hablado con) (a )?nadie\b|\bno he salido\b|\bestoy (muy )?(sol[oa]|abandonad[oa])\b|\bme siento (sol[oa]|abandonad[oa])\b/),
  R('dosis.olvidada', 'dosis_olvidada', 1, 'explicito', new RegExp(`\\bse me olvido (tomar )?(la |el |las |los )?${MEDICAMENTOS}\\b|\\bno me tome (la |el |las |los )?${MEDICAMENTOS}\\b`)),
];
