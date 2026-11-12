/**
 * Textos de los recordatorios de medicación. Son PLANTILLAS, no los genera el modelo: dicen
 * exactamente lo que registró el equipo de salud (nombre, para qué y cómo se toma) y nunca
 * sugieren cambiar, saltar ni duplicar una dosis.
 *
 * TODO(clinico): redacción revisada por la enfermera de enlace y probada en voz alta con
 * personas mayores del co-diseño.
 */

const HORAS = ['doce', 'una', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once'];

/** "08:00" → "las ocho de la mañana"; "13:30" → "la una y media de la tarde". */
export function horaParaVoz(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const base = HORAS[h % 12]!;
  const articulo = h % 12 === 1 ? 'la' : 'las';
  const minutos = m === 0 ? '' : m === 15 ? ' y cuarto' : m === 30 ? ' y media' : m === 45 ? ' y cuarenta y cinco' : ` y ${m}`;
  const parte = h === 0 ? ' de la noche' : h < 12 ? ' de la mañana' : h === 12 ? ' del día' : h < 20 ? ' de la tarde' : ' de la noche';
  return `${articulo} ${base}${minutos}${parte}`;
}

export interface MedicamentoParaTexto {
  nombre: string;
  propositoSimple: string | null;
  dosisTexto: string;
}

function describir(m: MedicamentoParaTexto): string {
  return `${m.nombre}${m.propositoSimple ? `, ${m.propositoSimple}` : ''}, ${m.dosisTexto}`;
}

function enumerar(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join('; ')}; y ${xs.at(-1)}`;
}

export function textoRecordatorio(p: { nombrePersona: string; trato: 'usted' | 'tu'; hora: string; medicamentos: MedicamentoParaTexto[]; segundoAviso: boolean }): string {
  const varios = p.medicamentos.length > 1;
  const lista = enumerar(p.medicamentos.map(describir));
  const hora = horaParaVoz(p.hora);
  const usted = p.trato === 'usted';
  if (!p.segundoAviso) {
    const intro = varios ? `es la hora de ${usted ? 'sus' : 'tus'} remedios de ${hora}` : `es la hora de ${usted ? 'su' : 'tu'} remedio de ${hora}`;
    const pedido = usted ? `¿Me avisa cuando ${varios ? 'se los tome' : 'se lo tome'}?` : `¿Me avisas cuando ${varios ? 'te los tomes' : 'te lo tomes'}?`;
    return `${p.nombrePersona}, ${intro}: ${lista}. ${pedido}`;
  }
  const intro = usted ? `le recuerdo ${varios ? 'sus remedios' : 'su remedio'} de ${hora}` : `te recuerdo ${varios ? 'tus remedios' : 'tu remedio'} de ${hora}`;
  const pregunta = usted ? `¿Ya ${varios ? 'se los tomó' : 'se lo tomó'}?` : `¿Ya ${varios ? 'te los tomaste' : 'te lo tomaste'}?`;
  return `${p.nombrePersona}, ${intro}: ${lista}. ${pregunta}`;
}
