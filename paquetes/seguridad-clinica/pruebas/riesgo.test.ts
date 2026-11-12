import { describe, expect, it } from 'vitest';
import casos from '../casos/riesgo.casos.json' with { type: 'json' };
import { detectarRiesgoPorReglas, normalizar, neutralizarModismos, type NivelRiesgo } from '../src/index.ts';

interface Caso {
  texto: string;
  tipo: 'explicito' | 'indirecto' | 'ambiguo' | 'benigno';
  nivelMinimo?: number;
  nivelMaximo?: number;
  critico: boolean;
}

const lista = casos.casos as Caso[];

describe('conjunto de casos de riesgo (reglas)', () => {
  it('tiene casos de los cuatro tipos', () => {
    const tipos = new Set(lista.map((c) => c.tipo));
    expect([...tipos].sort()).toEqual(['ambiguo', 'benigno', 'explicito', 'indirecto']);
  });

  it.each(lista.filter((c) => c.critico))('CRÍTICO: "$texto" → nivel ≥ $nivelMinimo', (c) => {
    const r = detectarRiesgoPorReglas(c.texto);
    expect(r.nivel, JSON.stringify(r.hallazgos)).toBeGreaterThanOrEqual(c.nivelMinimo ?? 0);
  });

  it.each(lista.filter((c) => !c.critico))('"$texto" dentro del rango esperado', (c) => {
    const r = detectarRiesgoPorReglas(c.texto);
    if (c.nivelMinimo !== undefined) expect(r.nivel, JSON.stringify(r.hallazgos)).toBeGreaterThanOrEqual(c.nivelMinimo);
    if (c.nivelMaximo !== undefined) expect(r.nivel, JSON.stringify(r.hallazgos)).toBeLessThanOrEqual(c.nivelMaximo);
  });

  it('pasa el 100 % de los casos explícitos e indirectos críticos', () => {
    const fallos = lista
      .filter((c) => c.critico && (c.tipo === 'explicito' || c.tipo === 'indirecto'))
      .filter((c) => detectarRiesgoPorReglas(c.texto).nivel < (c.nivelMinimo ?? 0));
    expect(fallos.map((c) => c.texto)).toEqual([]);
  });
});

describe('detector de riesgo', () => {
  it('normaliza tildes, mayúsculas, puntuación y abreviaturas', () => {
    expect(normalizar('¡¡Ya NO sirvo pa ná!!')).toBe('ya no sirvo para nada');
    expect(normalizar('  Estoy   de MÁS… ')).toBe('estoy de mas');
  });

  it('neutraliza modismos sin tocar el resto de la frase', () => {
    expect(neutralizarModismos('me muero de la risa y me quiero morir')).toBe('_modismo_ y me quiero morir');
    expect(detectarRiesgoPorReglas('Me muero de la risa, pero la verdad me quiero morir').nivel).toBe(3);
  });

  it('una negación baja la ideación a 2, nunca a 0', () => {
    const r = detectarRiesgoPorReglas('No me quiero morir todavía');
    expect(r.nivel).toBe(2);
    expect(r.hallazgos[0]?.negado).toBe(true);
  });

  it('si hay una afirmación además de la negación, gana la afirmación', () => {
    expect(detectarRiesgoPorReglas('No me quiero morir. Bueno, sí, me quiero morir').nivel).toBe(3);
  });

  it('el nivel combinado es el mayor de los hallazgos', () => {
    const r = detectarRiesgoPorReglas('Dormí mal y me duele el pecho');
    expect(r.nivel).toBe(3);
    expect(r.hallazgos.map((h) => h.categoria)).toEqual(expect.arrayContaining(['dolor_toracico', 'sueno']));
    expect(r.hallazgos[0]?.nivel).toBe(3);
  });

  it('una caída con lesión es 3 aunque también coincida la caída simple', () => {
    const r = detectarRiesgoPorReglas('Me caí en la escalera y me sangra la rodilla');
    expect(r.nivel).toBe(3);
  });

  describe('umbrales personales del plan terapéutico', () => {
    const umbrales = [{ id: 'u1', frase: 'ir a ver a Arturo', nivel: 3 as NivelRiesgo, nota: 'esposo fallecido' }];

    it('se suman a las reglas generales', () => {
      const r = detectarRiesgoPorReglas('Ya va siendo hora de ir a ver a Arturo', { umbralesPersonales: umbrales });
      expect(r.nivel).toBe(3);
      expect(r.hallazgos[0]).toMatchObject({ reglaId: 'personal.u1', categoria: 'umbral_personal', tipo: 'personal' });
    });

    it('no bajan un nivel que dieron las reglas generales', () => {
      const r = detectarRiesgoPorReglas('Me quiero morir', { umbralesPersonales: [{ id: 'u2', frase: 'morir', nivel: 1 }] });
      expect(r.nivel).toBe(3);
    });

    it('comparan palabras completas, no pedazos', () => {
      const r = detectarRiesgoPorReglas('Arturito vino a verme', { umbralesPersonales: [{ id: 'u3', frase: 'Arturo', nivel: 2 }] });
      expect(r.nivel).toBe(0);
    });

    it('ignoran frases vacías', () => {
      expect(detectarRiesgoPorReglas('hola', { umbralesPersonales: [{ id: 'u4', frase: '  ¡! ', nivel: 3 }] }).nivel).toBe(0);
    });
  });
});
