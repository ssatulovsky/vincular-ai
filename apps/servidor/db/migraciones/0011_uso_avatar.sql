-- Avatar animado en tiempo real: minutos por persona y sesión. Sirve para el tope diario por
-- persona (costo) y para medir el costo mensual. No guarda imagen, audio ni texto: solo tiempos.
CREATE TABLE uso_avatar (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id  uuid NOT NULL REFERENCES persona (id) ON DELETE CASCADE,
  sesion_id   uuid REFERENCES sesion_conversacion (id) ON DELETE SET NULL,
  proveedor   text NOT NULL,
  inicio      timestamptz NOT NULL DEFAULT now(),
  fin         timestamptz,
  -- Por qué terminó: 'fin_sesion', 'desconectado', 'sin_video', 'error_inicio'.
  motivo_fin  text,
  error       text
);
CREATE INDEX ON uso_avatar (persona_id, inicio DESC);
GRANT SELECT, INSERT, UPDATE ON uso_avatar TO vincular_app;
