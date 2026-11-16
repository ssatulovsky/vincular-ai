import type { Aplicacion } from './api/servidor.ts';
import { cicloMedicacion } from './medicacion/agenda.ts';
import { procesarPendientes } from './memoria/extraccion.ts';
import { cicloEscalamiento } from './escalamiento/motor.ts';

/**
 * Planificador en el proceso del servidor. Corre tareas idempotentes cuyo estado vive en la
 * base, así que varias instancias pueden convivir. Para 40–60 personas basta; el Sprint 8
 * evalúa una cola (Redis/BullMQ) si aparecen más tareas o más carga.
 */
export class Planificador {
  private temporizadores: NodeJS.Timeout[] = [];
  private enCurso = new Set<string>();
  private pendiente = new Set<string>();

  constructor(
    private readonly app: Aplicacion,
    private readonly registrar: (msg: string) => void = (m) => console.error(m),
  ) {}

  iniciar(): void {
    this.cada('escalamiento', 15_000, () => this.escalar());
    // Una cadena recién iniciada (p. ej. una emergencia) se ejecuta sin esperar el ciclo.
    this.app.despertarEscalamiento = () => this.ahora('escalamiento', () => this.escalar());
    this.cada('medicacion', 20_000, async () => {
      await cicloMedicacion({ bd: this.app.bd, cifrador: this.app.cifrador, entrega: this.app.tablets, plazos: this.app.config.medicacion }, new Date());
    });
    this.cada('memoria', 5 * 60_000, async () => {
      await procesarPendientes({ bd: this.app.bd, cifrador: this.app.cifrador, modelos: this.app.modelos }, { minutosInactividad: this.app.config.memoriaMinutosInactividad });
    });
  }

  private async escalar(): Promise<void> {
    await cicloEscalamiento(this.app.escalamiento, new Date());
  }

  detener(): void {
    this.app.despertarEscalamiento = () => undefined;
    for (const t of this.temporizadores) clearInterval(t);
    this.temporizadores = [];
  }

  private ahora(nombre: string, fn: () => Promise<void>): void {
    if (this.enCurso.has(nombre)) {
      // Ya hay una ejecución: se repite al terminar para tomar lo recién llegado.
      this.pendiente.add(nombre);
      return;
    }
    this.enCurso.add(nombre);
    fn()
      .catch((e: Error) => this.registrar(`[planificador:${nombre}] ${e.message}`))
      .finally(() => {
        this.enCurso.delete(nombre);
        if (this.pendiente.delete(nombre)) this.ahora(nombre, fn);
      });
  }

  private cada(nombre: string, ms: number, fn: () => Promise<void>): void {
    const correr = () => {
      // Una ejecución a la vez por tarea; si ya corre, no se acumulan ciclos.
      if (!this.enCurso.has(nombre)) this.ahora(nombre, fn);
    };
    this.temporizadores.push(setInterval(correr, ms));
    correr();
  }
}
