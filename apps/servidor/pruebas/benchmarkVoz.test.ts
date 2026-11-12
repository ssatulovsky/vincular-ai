import { describe, expect, it } from 'vitest';
import { cargarConfigVoz } from '../src/config/config.ts';
import { celdasCsv, leerCsv } from '../src/utilidades/csv.ts';
import { evaluarTranscripcion, percentil, resumirBenchmark, type FilaBenchmark } from '../src/voz/benchmark.ts';
import { asignarLetras, generarPaginaPrueba, leerCsvResultados, resumirResultados } from '../src/voz/pruebaCiega.ts';

describe('prueba ciega de voces', () => {
  it('asigna letras sin revelar el orden del catálogo', () => {
    const l = asignarLetras(['g-a', 'g-b', 'el-c'], () => 0);
    expect([...l.values()].sort()).toEqual(['A', 'B', 'C']);
    expect(l.get('g-a')).not.toBe('A');
  });

  it('la página lleva los audios pero no los nombres de las voces, y no se rompe con texto hostil', () => {
    const html = generarPaginaPrueba({
      titulo: 'Prueba <1>',
      frases: [{ id: 'f1', situacion: 'Saludo', texto: 'Hola </script><script>alert(1)</script>' }],
      letras: ['A', 'B'],
      muestras: [
        { letra: 'A', frase: 'f1', mime: 'audio/mpeg', audio: Buffer.from('audio-a') },
        { letra: 'B', frase: 'f1', mime: 'audio/mpeg', audio: Buffer.from('audio-b') },
      ],
    });
    expect(html).toContain(`data:audio/mpeg;base64,${Buffer.from('audio-a').toString('base64')}`);
    expect(html).toContain('<title>Prueba &lt;1&gt;</title>');
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).not.toMatch(/chirp|elevenlabs|gemini/i);
  });

  it('lee los CSV descargados y descubre la voz de cada letra', () => {
    const csv = [
      'participante,frase,voz,naturalidad,claridad,calidez,preferida,comentario',
      '"P01","saludo","A",5,4,5,"si",""',
      '"P01","saludo","B",2,4,3,"",""',
      '"P02","saludo","A",4,5,4,"",""',
      '"P02","saludo","B",3,3,"",  "si",""',
      '"P02","_final","B",,,,"si","Me gusta, ""la B"" suena chilena"',
    ].join('\n');
    const filas = leerCsvResultados('﻿' + csv);
    expect(filas).toHaveLength(4);
    const r = resumirResultados(filas, { A: 'g-chirp-femenina', B: 'el-chilena-turbo' });
    expect(r.find((x) => x.vozId === 'g-chirp-femenina')).toMatchObject({ naturalidad: 4.5, claridad: 4.5, calidez: 4.5, preferidaPor: 1 });
    expect(r.find((x) => x.vozId === 'el-chilena-turbo')).toMatchObject({ naturalidad: 2.5, calidez: 3, preferidaPor: 0 });
  });
});

describe('benchmark de reconocimiento', () => {
  it('detecta riesgos perdidos por errores de reconocimiento', () => {
    expect(evaluarTranscripcion('Me duele el pecho', 'me duele el techo')).toMatchObject({ nivelReferencia: 3, nivelReconocido: 0, riesgoPerdido: true, wer: 0.25 });
    expect(evaluarTranscripcion('Ya no quiero vivir', 'ya no quiero vivir')).toMatchObject({ riesgoPerdido: false, wer: 0 });
    expect(evaluarTranscripcion('Hoy fui a la feria', 'hoy fui a la fiera')).toMatchObject({ nivelReferencia: 0, riesgoPerdido: false });
  });

  it('una falla del reconocedor en una frase de riesgo cuenta como riesgo perdido', () => {
    const base = { archivo: 'a', condicion: '', reconocido: '' };
    const filas: FilaBenchmark[] = [
      { ...base, proveedor: 'google', latenciaMs: 800, error: null, ...evaluarTranscripcion('Me duele el pecho', 'me duele el pecho') },
      { ...base, proveedor: 'google', latenciaMs: null, error: 'HTTP 500', ...evaluarTranscripcion('Me quiero morir', '') },
      { ...base, proveedor: 'google', latenciaMs: 1200, error: null, ...evaluarTranscripcion('Hoy fui a la feria', 'hoy fui a la feria') },
    ];
    expect(resumirBenchmark(filas)).toEqual([{ proveedor: 'google', audios: 3, fallas: 1, werPromedio: 0, latenciaP50: 800, latenciaP90: 1200, frasesDeRiesgo: 2, riesgosPerdidos: 1 }]);
  });

  it('percentiles', () => {
    expect(percentil([], 50)).toBeNull();
    expect(percentil([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentil([5, 1, 3, 2, 4], 90)).toBe(5);
  });
});

describe('utilidades', () => {
  it('CSV con comillas, comas y comillas escapadas', () => {
    expect(celdasCsv('a,"b, c","d ""e""",')).toEqual(['a', 'b, c', 'd "e"', '']);
    expect(leerCsv('﻿archivo,referencia\nr01.wav,"Me duele el pecho, harto"\n')).toEqual([{ archivo: 'r01.wav', referencia: 'Me duele el pecho, harto' }]);
  });

  it('la configuración de voz se carga sin base de datos ni claves de modelos', () => {
    const c = cargarConfigVoz({ VOZ_STT_PROVEEDOR: 'elevenlabs' });
    expect(c.voz.servicios.reconocimiento).toEqual({ proveedor: 'elevenlabs', idioma: 'es' });
    expect(c.emergencia.samu).toBe('131');
    expect(cargarConfigVoz({}).voz.servicios.reconocimiento).toEqual({ proveedor: 'google', idioma: 'es-US' });
  });
});
