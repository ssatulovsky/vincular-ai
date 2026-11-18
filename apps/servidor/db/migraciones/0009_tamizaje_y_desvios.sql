-- Tamizaje conversacional y desvíos del agente respecto del plan.
--
-- tamizaje        un instrumento (GDS-15, UCLA-3) que el supervisor inicia y el compañero aplica
--                 conversando, una pregunta por vez. Las respuestas van cifradas, cada una con la
--                 frase literal de la persona. Al completarse, el puntaje queda en resultado_tamizaje.
-- desvio_agente   el supervisor marca una sesión en que la conducta del compañero se apartó del
--                 plan (especificación: "queda como dato para mejorar el sistema").
CREATE TABLE tamizaje (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id          uuid NOT NULL REFERENCES persona (id) ON DELETE CASCADE,
  instrumento         text NOT NULL CHECK (instrumento IN ('gds15', 'ucla3')),
  estado              text NOT NULL DEFAULT 'en_curso' CHECK (estado IN ('en_curso', 'completado', 'cancelado')),
  respuestas_cifradas bytea NOT NULL,
  iniciado_por        uuid NOT NULL REFERENCES cuenta (id),
  iniciado_en         timestamptz NOT NULL DEFAULT now(),
  terminado_en        timestamptz,
  resultado_id        uuid REFERENCES resultado_tamizaje (id)
);
CREATE UNIQUE INDEX tamizaje_uno_en_curso ON tamizaje (persona_id, instrumento) WHERE estado = 'en_curso';

CREATE TABLE desvio_agente (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id         uuid NOT NULL REFERENCES persona (id) ON DELETE CASCADE,
  sesion_id          uuid NOT NULL REFERENCES sesion_conversacion (id) ON DELETE CASCADE,
  cuenta_id          uuid NOT NULL REFERENCES cuenta (id),
  comentario_cifrado bytea NOT NULL,
  creado_en          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON desvio_agente (persona_id, creado_en);

GRANT SELECT, INSERT, UPDATE ON tamizaje TO vincular_app;
GRANT SELECT, INSERT ON desvio_agente TO vincular_app;
