-- Sprint 3: voz. Velocidad elegida por la persona y medición de latencia y uso por turno hablado.
-- El audio NO se guarda: solo su duración y las métricas.

ALTER TABLE perfil_companero
  ADD COLUMN velocidad_voz numeric(3, 2) NOT NULL DEFAULT 1.00 CHECK (velocidad_voz BETWEEN 0.70 AND 1.20);

CREATE TABLE medicion_voz (
  id                    bigserial PRIMARY KEY,
  persona_id            uuid REFERENCES persona (id) ON DELETE SET NULL,
  sesion_id             uuid REFERENCES sesion_conversacion (id) ON DELETE SET NULL,
  turno_agente_id       uuid REFERENCES turno (id) ON DELETE SET NULL,
  stt_proveedor         text NOT NULL,
  stt_modelo            text NOT NULL,
  stt_ms                integer,
  stt_confianza         real,
  stt_segundos_audio    real,
  stt_ok                boolean NOT NULL,
  -- Se pidió repetir porque no se entendió (y no había señal de riesgo).
  pidio_repetir         boolean NOT NULL DEFAULT false,
  orquestador_ms        integer,
  tts_proveedor         text,
  tts_motor             text,
  tts_voz_id            text,
  tts_caracteres        integer NOT NULL DEFAULT 0,
  tts_frases            smallint NOT NULL DEFAULT 0,
  tts_primer_audio_ms   integer,
  tts_ok                boolean,
  -- Desde que llegó el audio de la persona hasta que salió el primer audio de respuesta.
  total_primer_audio_ms integer,
  creado_en             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON medicion_voz (creado_en);
CREATE INDEX ON medicion_voz (persona_id, creado_en);

GRANT SELECT, INSERT ON medicion_voz TO vincular_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO vincular_app;
