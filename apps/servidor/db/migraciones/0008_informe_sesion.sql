-- Resumen de sesión para el supervisor (especificación, «Supervisión clínica»).
--
-- informe_sesion  ahora guarda por qué se rechazó (errores de validación: citas que no están en
--                 la transcripción, diagnósticos, lecturas sin sesiones previas), qué lentes
--                 teóricas estaban activas y con qué modelo se generó.
-- sesion_conversacion  intentos fallidos de generación (proveedor caído), para no reintentar
--                 sin fin.
ALTER TABLE informe_sesion
  ADD COLUMN errores        text[] NOT NULL DEFAULT '{}',
  ADD COLUMN lentes         text[] NOT NULL DEFAULT '{}',
  ADD COLUMN modelo         text,
  ADD COLUMN intentos       smallint NOT NULL DEFAULT 1,
  ADD COLUMN actualizado_en timestamptz NOT NULL DEFAULT now();

ALTER TABLE sesion_conversacion
  ADD COLUMN informe_intentos     smallint NOT NULL DEFAULT 0,
  ADD COLUMN informe_ultimo_error text;
