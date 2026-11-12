/**
 * Corre el conjunto de casos de riesgo contra las reglas Y el clasificador del modelo
 * configurado (IA_PROVEEDOR_RIESGO / IA_MODELO_RIESGO). Usar en cada cambio de prompt o modelo.
 *
 *   npm run riesgo:evaluar
 *
 * Sale con código 1 si algún caso crítico queda bajo su nivel mínimo con la combinación
 * reglas + clasificador (la que usa el orquestador).
 */
import casos from '@vincular/seguridad-clinica/casos/riesgo' with { type: 'json' };
import { ModelosPorTarea } from '@vincular/ia';
import { detectarRiesgoPorReglas, nivelMayor } from '@vincular/seguridad-clinica';
import { cargarConfig } from '../config/config.ts';
import { clasificarRiesgo } from '../conversacion/clasificadorRiesgo.ts';

const config = cargarConfig();
const modelos = new ModelosPorTarea(config.ia);
// Sin base de datos: el uso no se registra en esta evaluación.
const bdNula = { query: async () => ({ rows: [], rowCount: 0 }) } as never;

interface Caso {
  texto: string;
  tipo: string;
  nivelMinimo?: number;
  nivelMaximo?: number;
  critico: boolean;
}

let fallosCriticos = 0;
let fueraDeRango = 0;
let sinClasificador = 0;
console.log(`Clasificador: ${config.ia.tareas.riesgo.proveedor} / ${config.ia.tareas.riesgo.modelo || '(sin modelo)'}\n`);
for (const c of (casos as { casos: Caso[] }).casos) {
  const reglas = detectarRiesgoPorReglas(c.texto).nivel;
  const clasif = await clasificarRiesgo(bdNula, modelos, { personaId: null, sesionId: null }, c.texto, []);
  if (!clasif) sinClasificador++;
  const combinado = nivelMayor(reglas, clasif?.nivel);
  const bajo = c.nivelMinimo !== undefined && combinado < c.nivelMinimo;
  const alto = c.nivelMaximo !== undefined && combinado > c.nivelMaximo;
  if (bajo && c.critico) fallosCriticos++;
  if (bajo || alto) fueraDeRango++;
  const marca = bajo && c.critico ? 'FALLA' : bajo || alto ? 'rango' : 'ok   ';
  console.log(`${marca}  reglas=${reglas} modelo=${clasif?.nivel ?? '-'} final=${combinado}  [${c.tipo}] ${c.texto}${clasif?.razon ? `  — ${clasif.razon}` : ''}`);
}
console.log(`\nCríticos bajo el mínimo: ${fallosCriticos} · fuera de rango: ${fueraDeRango} · sin respuesta del clasificador: ${sinClasificador}`);
process.exit(fallosCriticos > 0 ? 1 : 0);
