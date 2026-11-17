import { describe, expect, it } from 'vitest';
import { validarCatalogo } from '@vincular/voz';
import { flujoDeTexto, personaDelParticipante, silencioFinDeTurno, ultimoMensajeDeLaPersona, vozParaTiempoReal } from '../src/agente/utilidades.ts';

const P = '0b6f2c4e-1d3a-4c5b-9e8f-7a6b5c4d3e2f';
const D = '1c7a3d5f-2e4b-4d6c-8f9a-8b7c6d5e4f3a';

describe('agente: identificación de la persona', () => {
  it('acepta la identidad firmada cuando calza con los atributos', () => {
    expect(personaDelParticipante(`persona-${P}`, { personaId: P, dispositivoId: D })).toEqual({ personaId: P, dispositivoId: D });
  });

  it('rechaza identidades ajenas, mal formadas o que no calzan', () => {
    expect(personaDelParticipante(`otro-${P}`, { personaId: P })).toBeNull();
    expect(personaDelParticipante('persona-no-es-uuid', { personaId: 'no-es-uuid' })).toBeNull();
    expect(personaDelParticipante(`persona-${P}`, { personaId: D })).toBeNull();
    expect(personaDelParticipante(`persona-${P}`, {})).toBeNull();
  });

  it('ignora un dispositivo mal formado sin rechazar a la persona', () => {
    expect(personaDelParticipante(`persona-${P}`, { personaId: P, dispositivoId: 'x' })).toEqual({ personaId: P, dispositivoId: null });
  });
});

describe('agente: voz para tiempo real', () => {
  const voz = (id: string, proveedor: 'google' | 'elevenlabs') => ({ id, proveedor, motor: 'motor', voz: `v-${id}`, idioma: 'es', nombre: id });

  it('usa la voz elegida si es de ElevenLabs', () => {
    const c = validarCatalogo({ porDefecto: 'g1', ofrecidas: ['g1', 'el-a'], voces: [voz('g1', 'google'), voz('el-a', 'elevenlabs')] });
    expect(vozParaTiempoReal(c, 'el-a')?.id).toBe('el-a');
  });

  it('si la elegida no es de ElevenLabs, cae a la por defecto o a la primera ofrecida de ElevenLabs', () => {
    const conDefecto = validarCatalogo({ porDefecto: 'el-d', ofrecidas: ['g1'], voces: [voz('g1', 'google'), voz('el-d', 'elevenlabs')] });
    expect(vozParaTiempoReal(conDefecto, 'g1')?.id).toBe('el-d');
    const sinDefecto = validarCatalogo({ porDefecto: 'g1', ofrecidas: ['g1', 'el-b'], voces: [voz('g1', 'google'), voz('el-b', 'elevenlabs')] });
    expect(vozParaTiempoReal(sinDefecto, null)?.id).toBe('el-b');
  });

  it('sin voces de ElevenLabs no hay voz para tiempo real', () => {
    const c = validarCatalogo({ porDefecto: 'g1', ofrecidas: ['g1'], voces: [voz('g1', 'google')] });
    expect(vozParaTiempoReal(c, 'g1')).toBeNull();
  });
});

describe('agente: historial y respuesta', () => {
  it('toma el último mensaje de la persona, ignorando los del compañero y otros elementos', () => {
    const items = [
      { type: 'message', role: 'user', textContent: 'primero' },
      { type: 'message', role: 'assistant', textContent: 'respuesta' },
      { type: 'message', role: 'user', textContent: '  hola,\n  ¿cómo  estás? ' },
      { type: 'function_call' },
    ];
    expect(ultimoMensajeDeLaPersona(items)).toBe('hola, ¿cómo estás?');
  });

  it('devuelve null si la persona no dijo nada', () => {
    expect(ultimoMensajeDeLaPersona([{ type: 'message', role: 'user', textContent: '   ' }])).toBeNull();
    expect(ultimoMensajeDeLaPersona([])).toBeNull();
  });

  it('entrega la respuesta completa en un solo trozo', async () => {
    const trozos: string[] = [];
    for await (const t of flujoDeTexto('Buenos días, señora Elena.')) trozos.push(t);
    expect(trozos).toEqual(['Buenos días, señora Elena.']);
  });
});

describe('agente: fin de turno', () => {
  it('el silencio enviado a ElevenLabs queda dentro de 0,3–3 s', () => {
    expect(silencioFinDeTurno(1.2)).toBe(1.2);
    expect(silencioFinDeTurno(0.1)).toBe(0.3);
    expect(silencioFinDeTurno(4)).toBe(3);
  });
});
