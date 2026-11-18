-- Panel familiar: propuestas de la familia (especificación: "puede proponer recordatorios").
-- No se aplican solas: las revisa el equipo clínico asignado, que acepta o descarta con una
-- respuesta que la familia ve.
CREATE TABLE propuesta_familiar (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id         uuid NOT NULL REFERENCES persona (id) ON DELETE CASCADE,
  contacto_id        uuid NOT NULL REFERENCES contacto (id),
  texto_cifrado      bytea NOT NULL,
  estado             text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'aceptada', 'descartada')),
  respuesta_cifrada  bytea,
  revisada_por       uuid REFERENCES cuenta (id),
  revisada_en        timestamptz,
  creada_en          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON propuesta_familiar (persona_id, creada_en DESC);
GRANT SELECT, INSERT, UPDATE ON propuesta_familiar TO vincular_app;
