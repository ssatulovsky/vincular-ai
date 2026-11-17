-- Diseño del compañero: género y edad aparente, y retratos generados para elegir el avatar.
--
-- avatar_propuesta  cada retrato generado (persona ficticia). La persona o el profesional elige
--                   uno; su id queda en perfil_companero.avatar_id. No es un dato de salud: la
--                   imagen no se cifra, pero solo la ven la tablet de la persona y su equipo.

ALTER TABLE perfil_companero
  ADD COLUMN genero        text CHECK (genero IN ('femenina', 'masculina')),
  ADD COLUMN edad_aparente text CHECK (edad_aparente IN ('joven', 'adulta', 'mayor'));

CREATE TABLE avatar_propuesta (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id  uuid NOT NULL REFERENCES persona (id) ON DELETE CASCADE,
  -- Ronda de generación: las 3 propuestas de una misma petición comparten ronda.
  ronda       uuid NOT NULL,
  genero      text NOT NULL CHECK (genero IN ('femenina', 'masculina')),
  edad        text NOT NULL CHECK (edad IN ('joven', 'adulta', 'mayor')),
  entorno     text NOT NULL CHECK (entorno IN ('cocina', 'jardin', 'living')),
  imagen      bytea NOT NULL CHECK (octet_length(imagen) BETWEEN 1 AND 4194304),
  mime        text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  modelo      text NOT NULL,
  creado_por  text NOT NULL CHECK (creado_por IN ('persona', 'personal')),
  creado_en   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON avatar_propuesta (persona_id, creado_en);

GRANT SELECT, INSERT, DELETE ON avatar_propuesta TO vincular_app;
