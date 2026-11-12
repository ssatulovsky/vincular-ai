/**
 * Busca voces en la biblioteca de ElevenLabs (por defecto, español con acento chileno).
 *
 *   npm run voz:voces -- [--acento chilean] [--genero female|male] [--pagina 0]
 *
 * Para usar una voz: agréguela a "Mis voces" en elevenlabs.io y copie su voice_id en
 * config/voz/voces.json.
 */
import { parseArgs } from 'node:util';
import { SintetizadorElevenLabs } from '@vincular/voz';

const { values } = parseArgs({ options: { acento: { type: 'string', default: 'chilean' }, genero: { type: 'string' }, pagina: { type: 'string' } } });
const clave = process.env.ELEVENLABS_API_KEY;
if (!clave) {
  console.error('Configure ELEVENLABS_API_KEY.');
  process.exit(1);
}
const voces = await new SintetizadorElevenLabs({ apiKey: clave }).buscarVoces({
  idioma: 'es',
  ...(values.acento ? { acento: values.acento } : {}),
  ...(values.genero ? { genero: values.genero } : {}),
  ...(values.pagina ? { pagina: Number(values.pagina) } : {}),
});
if (voces.length === 0) console.log('Sin resultados. Pruebe otro acento (p. ej. --acento latin american) o sin filtro de género.');
for (const v of voces) {
  console.log(`${v.voiceId}  ${v.nombre} · ${v.genero ?? '?'} · ${v.edad ?? '?'} · acento ${v.acento ?? '?'}`);
  if (v.descripcion) console.log(`    ${v.descripcion.slice(0, 140)}`);
  if (v.muestra) console.log(`    muestra: ${v.muestra}`);
}
