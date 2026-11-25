-- Verificación de preparación del piloto (decisión 0018): las tareas que el sistema no puede
-- comprobar solo (acuerdos con proveedores, revisión legal, guardia formalizada…) se marcan a
-- mano, con quién, cuándo y una nota (p. ej. el número del convenio).
CREATE TABLE preparacion_manual (
  clave          text PRIMARY KEY,
  completado     boolean NOT NULL DEFAULT false,
  nota           text NOT NULL DEFAULT '' CHECK (length(nota) <= 500),
  actualizado_por uuid REFERENCES cuenta (id) ON DELETE SET NULL,
  actualizado_en timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON preparacion_manual TO vincular_app;
