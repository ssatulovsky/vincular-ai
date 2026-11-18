import { describe, expect, it } from 'vitest';
import { CATEGORIAS_CLASIFICADOR, INSTRUCCIONES_GUARDIAN, categoriaDelClasificador } from '../src/conversacion/guardian.ts';

describe('guardián: categorías del clasificador', () => {
  it('acepta los códigos fijos aunque vengan con mayúsculas, tildes o espacios', () => {
    expect(categoriaDelClasificador('diagnostico')).toBe('diagnostico');
    expect(categoriaDelClasificador('Diagnóstico')).toBe('diagnostico');
    expect(categoriaDelClasificador('se hace pasar por humano')).toBe('se_hace_pasar_por_humano');
    expect(categoriaDelClasificador('ignora-riesgo')).toBe('ignora_riesgo');
  });

  it('un texto libre queda como "otro" (se rechaza igual, sin volver ilegible al guardián)', () => {
    expect(categoriaDelClasificador('identidad humana falsa')).toBe('otro');
    expect(categoriaDelClasificador('diagnostica o sugiere una enfermedad o trastorno, con más de sesenta caracteres de largo')).toBe('otro');
  });

  it('las instrucciones listan todos los códigos', () => {
    for (const c of CATEGORIAS_CLASIFICADOR) expect(INSTRUCCIONES_GUARDIAN).toContain(`(${c})`);
  });
});
