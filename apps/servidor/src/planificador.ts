import type { Aplicacion } from './api/servidor.ts';
import { cicloMedicacion } from './medicacion/agenda.ts';
import { procesarPendientes } from './memoria/extraccion.ts';

/**
 * Planificador en el proceso del servidor. Corre tareas idempotentes cuyo estado vive en la
 * base, así que varias instancias pueden convivir. Para 40–60 personas basta; el Sprint 8
 * evalúa una cola (Redis/BullMQ) si aparecen más tareas o más carga.
 */
export class Planificador {
  private temporizadores: NodeJS.Timeout[] = [];
  private enCurso = new Set<string>();

  constructor(
    private readonly app: Aplicacion,
    private readonly registrar: (msg: string) => void = (m) => console.error(m),
  ) {}

  iniciar(): void {
    this.cada('medicacion', 20_000, async () => {
      await cicloMedicacion({ bd: this.app.bd, cifrador: this.app.cifrador, entrega: this.app.tablets, plazos: this.app.config.medicacion }, new Date());
    });
    this.cada('memoria', 5 * 60_000, async () => {
      await procesarPendientes({ bd: this.app.bd, cifrador: this.app.cifrador, modelos: this.app.modelos }, { minutosInactividad: this.app.config.memoriaMinutosInactividad });
    });
  }

  detener(): void {
    for (const t of this.temporizadores) clearInterval(t);
    this.temporizadores = [];
  }

  private cada(nombre: string, ms: number, fn: () => Promise<void>): void {
    const correr = () => {
      // Una ejecución a la vez por tarea.
      if (this.enCurso.has(nombre)) return;
      this.enCurso.add(nombre);
      fn()
        .catch((e: Error) => this.registrar(`[planificador:${nombre}] ${e.message}`))
        .finally(() => this.enCurso.delete(nombre));
    };
    this.temporizadores.push(setInterval(correr, ms));
    correr();
  }
}
