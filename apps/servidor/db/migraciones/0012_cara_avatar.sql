-- Caras del avatar animado creadas en el proveedor a partir del retrato elegido (Simli necesita
-- construir la cara antes de usarla: unas 4 horas, y cada plan tiene un cupo mensual de caras).
-- Una fila por retrato y proveedor; el retrato es una persona ficticia generada (decisión 0007).
CREATE TABLE cara_avatar (
  avatar_id       uuid NOT NULL REFERENCES avatar_propuesta (id) ON DELETE CASCADE,
  proveedor       text NOT NULL,
  persona_id      uuid NOT NULL REFERENCES persona (id) ON DELETE CASCADE,
  cara_id         text,
  -- solicitando: alguien la está pidiendo · construyendo: el proveedor la arma · lista · fallida:
  -- el proveedor no pudo · sin_cupo: se acabaron las caras del plan · error: no se pudo pedir.
  estado          text NOT NULL CHECK (estado IN ('solicitando', 'construyendo', 'lista', 'fallida', 'sin_cupo', 'error')),
  detalle         text,
  creado_en       timestamptz NOT NULL DEFAULT now(),
  actualizado_en  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (avatar_id, proveedor)
);
CREATE INDEX ON cara_avatar (persona_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON cara_avatar TO vincular_app;
