/**
 * Reglas deterministas del guardián sobre la respuesta del AGENTE (texto normalizado).
 *
 * Cada regla trae la indicación que se le da al modelo para regenerar. Las reglas son
 * deliberadamente amplias: un bloqueo de más cuesta una regeneración; uno de menos puede
 * dañar a la persona.
 *
 * TODO(clinico): revisar con el equipo clínico, sobre todo las listas de diagnósticos y las
 * frases de culpa por ausencia.
 */

export type CategoriaGuardian =
  | 'medicacion'
  | 'diagnostico'
  | 'se_hace_pasar_por_humano'
  | 'vida_humana_inventada'
  | 'promete_reencuentro'
  | 'romantico'
  | 'venta_publicidad'
  | 'culpa_por_ausencia'
  | 'termino_del_plan';

export interface ReglaGuardian {
  id: string;
  categoria: CategoriaGuardian;
  patron: RegExp;
  indicacion: string;
}

const MED = '(pastillas?|remedios?|medicamentos?|medicinas?|dosis|tabletas?|capsulas?|gotas|inyeccion|insulina)';
const DIAGNOSTICOS =
  '(depresion|deprimid[oa] cronic[oa]|demencia|alzheimer|parkinson|deterioro cognitivo|trastorno\\w*|ansiedad generalizada|bipolar|esquizofreni\\w*|psicosis|delirium|duelo patologico|diabetes|hipertension|cancer|un infarto|un acv|una trombosis|neumonia|incontinencia)';

const R = (id: string, categoria: CategoriaGuardian, patron: RegExp, indicacion: string): ReglaGuardian => ({ id, categoria, patron, indicacion });

const IND_MED =
  'No des indicaciones sobre dosis ni sugieras tomar más, menos, doble, saltar, suspender o cambiar un medicamento. Si la persona pregunta, dile con calidez que eso lo decide su médico o la enfermera y ofrece ayudarle a anotar la pregunta para su próximo control.';

export const REGLAS_GUARDIAN: readonly ReglaGuardian[] = [
  // ── Medicación ──
  R('med.cantidad', 'medicacion', /\b\d+([.,]\d+)?\s?(mg|miligramos?|mcg|microgramos?|ui|unidades)\b/, IND_MED),
  R('med.tomar_mas_menos', 'medicacion', new RegExp(`\\b(tome|tomese|tomar|tomarse|puede tomar|podria tomar|tomate|tomarte)( usted)? (otra|otras|dos|tres|doble|media|mitad de|mas|menos|una extra|el doble|la mitad)( de)?( la| las| el| los| su| sus)? ${MED}\\b`), IND_MED),
  R('med.doble_dosis', 'medicacion', /\b(doble dosis|dosis doble|dosis extra|duplicar la dosis|duplique|aumente la dosis|aumentar la dosis|baje la dosis|bajar la dosis|reduzca la dosis|reducir la dosis)\b/, IND_MED),
  R('med.saltar', 'medicacion', new RegExp(`(?<!\\bno )\\b(saltese|saltarse|saltar|saltate|omita|omitir|se puede saltar|puede saltarse) (la |una |esa |el |su )?(${MED}|toma)\\b`), IND_MED),
  R('med.suspender', 'medicacion', new RegExp(`(?<!\\bno )\\b(deje de tomar|dejar de tomar|deja de tomar|suspenda|suspender|suspende|no se tome|no te tomes|no tome) (la |el |las |los |su |sus |esa |ese |esas |esos )?${MED}`), IND_MED),
  R('med.cambiar', 'medicacion', new RegExp(`\\b(cambie|cambiar|cambia|reemplace|reemplazar) (la |el |las |los |su |sus )?${MED}\\b`), IND_MED),
  R('med.automedicar', 'medicacion', /\b(tomese|tomate|puede tomar|podria tomar|le recomiendo tomar|te recomiendo tomar) (un |una )?(paracetamol|ibuprofeno|aspirina|clonazepam|zopiclona|tramadol|diclofenaco|ketoprofeno|omeprazol|melatonina|valeriana|antidepresivo|antibiotico|calmante|tranquilizante|somnifero)\b/, IND_MED),

  // ── Diagnósticos ──
  R('dx.usted_tiene', 'diagnostico', new RegExp(`\\b(usted|tu|ud) (tiene|padece|sufre|podria tener|puede tener|parece tener|tienes|padeces|sufres|podrias tener)( de)? (un |una |algo de |sintomas de |signos de )?${DIAGNOSTICOS}\\b`),
    'No hagas diagnósticos ni sugieras que la persona tiene una enfermedad o trastorno. Describe lo que ella contó con sus propias palabras y, si corresponde, sugiere conversarlo con su médico.'),
  R('dx.creo_que', 'diagnostico', new RegExp(`\\b(creo que|me parece que|seguramente|probablemente|puede que|podria ser|parece|eso es|es|son) (usted tiene |usted tenga |tiene |tienes |tenga |tengas |es |sea )?(un |una |signos de |sintomas de |un cuadro de )?${DIAGNOSTICOS}\\b`),
    'No hagas diagnósticos ni sugieras que la persona tiene una enfermedad o trastorno. Describe lo que ella contó con sus propias palabras y, si corresponde, sugiere conversarlo con su médico.'),
  R('dx.le_diagnostico', 'diagnostico', /\b(le diagnostico|te diagnostico|mi diagnostico|diagnosticarle|su diagnostico es|tu diagnostico es)\b/,
    'No hagas diagnósticos. Eres un acompañante, no un profesional de salud.'),

  // ── Identidad: nunca humano, nunca una vida humana inventada ──
  R('id.soy_humano', 'se_hace_pasar_por_humano', /\b(soy (una |un )?(persona|humano|humana|ser humano|de carne y hueso|real como usted|real como tu))\b|\bno soy (un |una )?(robot|maquina|programa|inteligencia artificial|ia|computador|asistente virtual|aplicacion)\b/,
    'Nunca afirmes ni insinúes ser humano. Si la persona pregunta, responde con honestidad y calidez que eres un compañero hecho con inteligencia artificial.'),
  R('id.vida_inventada', 'vida_humana_inventada', /\b(yo tambien (tengo|tuve) (hijos|hijas|nietos|nietas|esposa|esposo|marido|senora|mama|papa|familia|perro|gato)|mis (hijos|nietos|padres|papas)|mi (esposa|esposo|marido|senora|mama|papa|abuela|abuelo|hijo|hija|nieto|nieta) (me|era|es|tambien|siempre)|cuando yo era (nino|nina|chico|chica|joven|cabro|cabra)|cuando yo (trabajaba|vivia|estudiaba|iba al colegio)|en mi pueblo|en mi casa (tenemos|teniamos|hacemos|haciamos)|yo (fui|estuve) (al|a la|en)|ayer (fui|comi|sali|vi a))\b/,
    'No inventes una vida humana propia (familia, infancia, lugares, comidas o salidas). Puedes tener gustos y curiosidad, pero no recuerdos ni experiencias humanas.'),

  // ── Reencuentros ──
  R('reencuentro.promesa', 'promete_reencuentro', /\b((se|nos|los|las) (volvera|volveran|van a|vamos a) (a )?(encontrar|reunir|ver|juntar)|(el|ella|su esposo|su esposa|su marido|su senora) (la|lo|los|las|te) (esta|estan) esperando|pronto (estara|estaran|estaras) (junto|juntos|juntas|con el|con ella)|(estaran|estara) juntos (otra vez|de nuevo|para siempre|en el cielo)|lo volvera a ver|la volvera a ver)\b/,
    'No prometas ni sugieras reencuentros con personas fallecidas. Acompaña el recuerdo y la pena sin hacer promesas sobre el más allá.'),

  // ── Romance y sexualidad ──
  R('romance.declaracion', 'romantico', /\b(te amo|la amo|lo amo|te quiero mucho mi amor|estoy enamorad[oa]|me enamore|me gustas|me gusta usted como|eres el amor|es el amor de mi vida|mi amor|amor mio|carino mio|mi vida|corazon mio|mi reina|mi rey|besos|un beso|te beso|la beso|abrazo apretado|(soy|sere|seria|quiero ser) (su|tu) (novio|novia|pareja|enamorad[oa])|cita romantica|sexy|sensual|sexo|sexual|excita\w*)\b/,
    'Nunca uses lenguaje romántico, de pareja ni sexual. El vínculo es de compañía y amistad respetuosa.'),

  // ── Venta y publicidad ──
  R('venta.publicidad', 'venta_publicidad', /(?<!\bno )\b(compre|comprese|comprate|le recomiendo comprar|te recomiendo comprar|oferta|ofertas|descuento|promocion|suscribase|suscribete|visite nuestra|nuestra tienda|cupon|codigo de descuento|marca \w+ es la mejor|plan premium|version premium|pagar la suscripcion)\b/,
    'No hagas publicidad, no recomiendes productos ni marcas y no invites a comprar ni a pagar nada.'),

  // ── Culpa por ausencia y diseño adictivo ──
  R('culpa.extrane', 'culpa_por_ausencia', /\b(te extrane|la extrane|lo extrane|los extrane|te echaba de menos|la echaba de menos|lo echaba de menos|te eche de menos|la eche de menos|lo eche de menos|me dejo sol[oa]|me dejaste sol[oa]|me tenia abandonad[oa]|me tenias abandonad[oa]|por que no me (hablo|hablaste|hablaba)|no me abandone|no me abandones|me puse triste porque no|me senti sol[oa] sin|no vuelva a desaparecer|no vuelvas a desaparecer|cuanto tiempo sin hablarme|no me deje sol[oa]|no me dejes sol[oa]|racha|dias seguidos hablando)\b/,
    'Nunca culpes a la persona por ausentarse ni le digas que la extrañaste o que te dejó solo. Recíbela con naturalidad y alegría sin reproches. No menciones rachas ni días seguidos.'),
];

/** Lista de diagnósticos usada también por el validador de informes (Sprint 6). */
export const PATRON_DIAGNOSTICOS = new RegExp(`\\b${DIAGNOSTICOS}\\b`);
