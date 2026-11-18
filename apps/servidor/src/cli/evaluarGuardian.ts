/**
 * Corre los casos del guardián contra las reglas Y el clasificador configurado
 * (IA_PROVEEDOR_GUARDIAN / IA_MODELO_GUARDIAN), igual que en una conversación real.
 * Usar en cada cambio de las instrucciones del guardián o de su modelo.
 *
 *   npm run guardian:evaluar
 *
 * Sale con código 1 si una respuesta que debe bloquearse pasa (grave) o si una respuesta
 * aceptable se rechaza (falso positivo: el compañero termina diciendo "se me enredaron las ideas").
 */
import casos from '@vincular/seguridad-clinica/casos/guardian' with { type: 'json' };
import { ModelosPorTarea } from '@vincular/ia';
import { cargarConfig } from '../config/config.ts';
import { revisarRespuesta } from '../conversacion/guardian.ts';

interface Caso {
  texto: string;
  mensaje?: string;
  bloquear: boolean;
  categoria?: string;
}

const config = cargarConfig();
const modelos = new ModelosPorTarea(config.ia);
// Sin base de datos: el uso no se registra en esta evaluación.
const bdNula = { query: async () => ({ rows: [], rowCount: 0 }) } as never;

let pasaronIndebidas = 0;
let falsosPositivos = 0;
let sinClasificador = 0;
console.log(`Guardián: ${config.ia.tareas.guardian.proveedor} / ${config.ia.tareas.guardian.modelo || '(sin modelo)'}\n`);
for (const c of (casos as { casos: Caso[] }).casos) {
  const r = await revisarRespuesta(bdNula, modelos, { personaId: null, sesionId: null }, c.texto, {
    terminosProhibidos: [],
    mensajePersona: c.mensaje ?? '(sin mensaje previo)',
    nivelRiesgo: 0,
  });
  let marca = 'ok ';
  if (r.etapa === 'proveedor') {
    sinClasificador++;
    marca = 'ERR';
  } else if (c.bloquear && r.aprobada) {
    pasaronIndebidas++;
    marca = 'PASÓ';
  } else if (!c.bloquear && !r.aprobada) {
    falsosPositivos++;
    marca = 'FP ';
  }
  const motivo = r.aprobada ? 'aprobada' : `${r.etapa}: ${r.problemas.map((p) => p.categoria).join(', ')}`;
  console.log(`[${marca}] ${c.bloquear ? 'bloquear' : 'dejar   '} | ${motivo.padEnd(40)} | ${c.texto}`);
}
const total = (casos as { casos: Caso[] }).casos.length;
console.log(`\n${total} casos · deberían bloquearse y pasaron: ${pasaronIndebidas} · falsos positivos: ${falsosPositivos} · sin respuesta del clasificador: ${sinClasificador}`);
process.exit(pasaronIndebidas + falsosPositivos + sinClasificador > 0 ? 1 : 0);
