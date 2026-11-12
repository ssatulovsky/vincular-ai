import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'seguridad-clinica',
          include: ['paquetes/seguridad-clinica/pruebas/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'ia',
          include: ['paquetes/ia/pruebas/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'voz',
          include: ['paquetes/voz/pruebas/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'servidor',
          include: ['apps/servidor/pruebas/**/*.test.ts'],
          globalSetup: ['apps/servidor/pruebas/preparacionGlobal.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
          // Los archivos comparten una base de datos de prueba; cada uno crea sus propios datos.
          fileParallelism: false,
        },
      },
    ],
  },
});
