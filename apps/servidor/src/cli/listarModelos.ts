/** Lista los modelos que la clave configurada puede usar, para elegir IA_MODELO_<TAREA>. */
import { crearModelo, type Proveedor } from '@vincular/ia';

const proveedores: Array<[Proveedor, string | undefined]> = [
  ['gemini', process.env.GEMINI_API_KEY],
  ['anthropic', process.env.ANTHROPIC_API_KEY],
];
let alguno = false;
for (const [p, clave] of proveedores) {
  if (!clave) continue;
  alguno = true;
  const url = p === 'gemini' ? process.env.GEMINI_URL : process.env.ANTHROPIC_URL;
  try {
    const modelos = await crearModelo({ proveedor: p, modelo: '', timeoutMs: 30_000 }, clave, url).listarModelos();
    console.log(`\n${p} (${modelos.length}):\n${modelos.map((m) => `  ${m}`).join('\n')}`);
  } catch (e) {
    console.error(`${p}: ${(e as Error).message}`);
  }
}
if (!alguno) console.error('Configure GEMINI_API_KEY o ANTHROPIC_API_KEY.');
