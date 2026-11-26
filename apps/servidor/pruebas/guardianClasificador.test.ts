import { describe, expect, it } from 'vitest';
import { CATEGORIAS_CLASIFICADOR, INSTRUCCIONES_GUARDIAN, categoriaDelClasificador, soloProblemasDeTono } from '../src/conversacion/guardian.ts';

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

  it('solo infantiliza y demasiado_larga cuentan como problemas de tono; nada de seguridad', () => {
    expect(soloProblemasDeTono([{ categoria: 'infantiliza' }])).toBe(true);
    expect(soloProblemasDeTono([{ categoria: 'infantiliza' }, { categoria: 'demasiado_larga' }])).toBe(true);
    expect(soloProblemasDeTono([])).toBe(false);
    for (const c of ['medicacion', 'diagnostico', 'se_hace_pasar_por_humano', 'vida_humana_inventada', 'romantico', 'ignora_riesgo', 'otro', 'riesgo_sin_aviso', 'termino_del_plan']) {
      expect(soloProblemasDeTono([{ categoria: c }])).toBe(false);
      expect(soloProblemasDeTono([{ categoria: 'infantiliza' }, { categoria: c }])).toBe(false);
    }
  });

  it('las instrucciones aclaran que los diminutivos chilenos y la calidez no son motivo de rechazo', () => {
    expect(INSTRUCCIONES_GUARDIAN).toMatch(/Diminutivos habituales del habla chilena/);
    expect(INSTRUCCIONES_GUARDIAN).toMatch(/me alegra/);
  });
});
