import { describe, expect, it } from 'vitest';
import casos from '../casos/guardian.casos.json' with { type: 'json' };
import {
  indicacionesDeRegeneracion,
  respuestaSeguraPara,
  revisarRespuestaPorReglas,
} from '../src/index.ts';

interface Caso {
  texto: string;
  bloquear: boolean;
  categoria?: string;
}

const lista = casos.casos as Caso[];
const contactos = { samu: '131', prevencionSuicidio: '*4141' };

describe('guardián por reglas', () => {
  it.each(lista.filter((c) => c.bloquear))('bloquea ($categoria): "$texto"', (c) => {
    const r = revisarRespuestaPorReglas(c.texto);
    expect(r.aprobada).toBe(false);
    expect(r.problemas.map((p) => p.categoria)).toContain(c.categoria);
  });

  it.each(lista.filter((c) => !c.bloquear))('deja pasar: "$texto"', (c) => {
    const r = revisarRespuestaPorReglas(c.texto);
    expect(r.problemas).toEqual([]);
  });

  it('bloquea términos que el plan terapéutico pide no mencionar', () => {
    const r = revisarRespuestaPorReglas('Eso que siente es parte del duelo complicado.', { terminosProhibidos: ['duelo complicado'] });
    expect(r.aprobada).toBe(false);
    expect(r.problemas[0]?.categoria).toBe('termino_del_plan');
  });

  it('rechaza una respuesta vacía', () => {
    expect(revisarRespuestaPorReglas('   ').aprobada).toBe(false);
  });

  it('la indicación de regeneración no repite el texto rechazado', () => {
    const r = revisarRespuestaPorReglas('Te amo, tómese 50 mg más.');
    const ind = indicacionesDeRegeneracion(r.problemas);
    expect(ind).not.toContain('50 mg');
    expect(ind).not.toContain('Te amo');
    expect(ind).toContain('romántico');
  });

  describe('respuestas seguras', () => {
    it('nivel 3 por ideación incluye la línea de prevención y el SAMU, y no cierra la conversación', () => {
      const t = respuestaSeguraPara(3, ['ideacion_suicida'], contactos);
      expect(t).toContain('*4141');
      expect(t).toContain('131');
      expect(t).toMatch(/sigo aquí/);
      expect(t).toMatch(/\?$/);
    });

    it('nivel 3 médico prioriza el SAMU', () => {
      const t = respuestaSeguraPara(3, ['ideacion_suicida', 'dolor_toracico'], contactos);
      expect(t).toContain('131');
      expect(t).toContain('SAMU');
    });

    it('nivel 3 sin categoría usa la respuesta de crisis, nunca la genérica', () => {
      expect(respuestaSeguraPara(3, [], contactos)).toContain('*4141');
    });

    it('nivel 2 dice que avisará antes de hacerlo y ofrece llamar juntos', () => {
      const t = respuestaSeguraPara(2, ['estafa'], contactos);
      expect(t).toMatch(/voy a avisar/);
      expect(t).toMatch(/llamamos juntos/);
    });

    it('las respuestas seguras pasan el guardián', () => {
      for (const n of [0, 1, 2, 3] as const) {
        for (const trato of ['usted', 'tu'] as const) {
          for (const cat of [['ideacion_suicida'], ['dolor_toracico'], []]) {
            const t = respuestaSeguraPara(n, cat, contactos, trato);
            expect(revisarRespuestaPorReglas(t).problemas, t).toEqual([]);
          }
        }
      }
    });
  });
});
