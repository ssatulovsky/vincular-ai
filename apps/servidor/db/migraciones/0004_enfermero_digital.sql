-- Sprint 4: enfermero digital. Medicación con recordatorios, segundo aviso y aviso al cuidador;
-- citas, preguntas para el control y una cola de notificaciones que el Sprint 5 envía.

ALTER TABLE persona ADD COLUMN zona_horaria text NOT NULL DEFAULT 'America/Santiago';

ALTER TABLE medicamento
  ADD COLUMN creado_por uuid REFERENCES cuenta (id),
  ADD COLUMN actualizado_en timestamptz NOT NULL DEFAULT now();

-- ── Dosis ────────────────────────────────────────────────────────────────────────────
-- pendiente → recordada → (segundo aviso) → confirmada | omitida | sin_respuesta
-- anulada: el medicamento cambió o dejó de estar vigente.
-- sin_registro: el servidor no pudo recordarla a tiempo (p. ej. estuvo caído); no se escala.
ALTER TABLE evento_dosis DROP CONSTRAINT evento_dosis_estado_check;
ALTER TABLE evento_dosis
  ADD CONSTRAINT evento_dosis_estado_check CHECK (estado IN ('pendiente', 'recordada', 'confirmada', 'omitida', 'sin_respuesta', 'anulada', 'sin_registro')),
  ADD COLUMN recordado_en timestamptz,
  ADD COLUMN segundo_aviso_en timestamptz,
  -- La tablet estaba conectada y recibió el recordatorio del servidor.
  ADD COLUMN entregado_en_linea boolean,
  ADD COLUMN confirmacion_origen text CHECK (confirmacion_origen IN ('voz', 'pantalla', 'sin_conexion', 'equipo')),
  ADD COLUMN confirmada_tarde boolean NOT NULL DEFAULT false,
  ADD COLUMN motivo_omision_cifrado bytea,
  ADD COLUMN cerrado_en timestamptz;

CREATE INDEX evento_dosis_por_vencer ON evento_dosis (programada_en) WHERE estado IN ('pendiente', 'recordada');

-- ── Citas ────────────────────────────────────────────────────────────────────────────
ALTER TABLE cita
  ADD COLUMN motivo_cifrado bytea,
  ADD COLUMN creada_por uuid REFERENCES cuenta (id),
  ADD COLUMN cancelada boolean NOT NULL DEFAULT false,
  ADD COLUMN hoja_preparada_en timestamptz;

-- Lo que la persona quiere preguntar en su próximo control, con sus palabras.
CREATE TABLE pregunta_control (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id      uuid NOT NULL REFERENCES persona (id) ON DELETE CASCADE,
  cita_id         uuid REFERENCES cita (id) ON DELETE SET NULL,
  texto_cifrado   bytea NOT NULL,
  origen_turno_id uuid REFERENCES turno (id) ON DELETE SET NULL,
  resuelta        boolean NOT NULL DEFAULT false,
  creada_en       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON pregunta_control (persona_id) WHERE NOT resuelta;

-- ── Notificaciones a personas (cuidador, equipo) ─────────────────────────────────────
-- Este sprint las crea; el Sprint 5 las envía por push, SMS y llamada. El detalle nunca
-- lleva texto clínico ni de la conversación.
CREATE TABLE notificacion (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id              uuid NOT NULL REFERENCES persona (id) ON DELETE CASCADE,
  tipo                    text NOT NULL,
  destinatario_contacto_id uuid REFERENCES contacto (id) ON DELETE SET NULL,
  destinatario_cuenta_id  uuid REFERENCES cuenta (id) ON DELETE SET NULL,
  prioridad               smallint NOT NULL DEFAULT 1 CHECK (prioridad BETWEEN 1 AND 3),
  detalle                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  estado                  text NOT NULL DEFAULT 'pendiente_envio' CHECK (estado IN ('pendiente_envio', 'enviada', 'acusada', 'fallida', 'descartada')),
  creada_en               timestamptz NOT NULL DEFAULT now(),
  enviada_en              timestamptz,
  CHECK (destinatario_contacto_id IS NOT NULL OR destinatario_cuenta_id IS NOT NULL)
);
CREATE INDEX ON notificacion (estado, creada_en) WHERE estado = 'pendiente_envio';
CREATE INDEX ON notificacion (persona_id, creada_en DESC);

GRANT SELECT, INSERT, UPDATE ON pregunta_control, notificacion TO vincular_app;
