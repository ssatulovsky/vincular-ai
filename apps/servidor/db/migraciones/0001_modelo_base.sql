-- Modelo de datos del MVP (especificación, sección 8).
--
-- Convenciones:
--   * Columnas *_cifrado (bytea): texto cifrado por la aplicación con AES-256-GCM. Todo texto de
--     conversación y todo dato de salud o identificatorio va cifrado.
--   * Las tablas de registro (turnos, planes, auditoría, intervenciones del guardián) no se
--     modifican: la aplicación solo puede insertar y leer.
--   * Fechas siempre timestamptz.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE EXCEPTION 'Falta la extensión vector (pgvector). Ejecute db/bootstrap.sql con un superusuario.';
  END IF;
END $$;

-- ── Personas y su compañero ──────────────────────────────────────────────────────────

CREATE TABLE persona (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre_cifrado               bytea NOT NULL,
  fecha_nacimiento             date,
  comuna                       text NOT NULL,
  estado                       text NOT NULL DEFAULT 'onboarding'
                               CHECK (estado IN ('onboarding', 'activa', 'pausada', 'baja')),
  consentimiento_vigente_hasta date,
  representante_legal_id       uuid,
  creada_en                    timestamptz NOT NULL DEFAULT now(),
  actualizada_en               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE perfil_companero (
  persona_id     uuid PRIMARY KEY REFERENCES persona (id) ON DELETE CASCADE,
  nombre         text NOT NULL CHECK (length(nombre) BETWEEN 1 AND 40),
  personalidad   text NOT NULL DEFAULT '' CHECK (length(personalidad) <= 600),
  forma_de_hablar text NOT NULL DEFAULT '' CHECK (length(forma_de_hablar) <= 600),
  trato          text NOT NULL DEFAULT 'usted' CHECK (trato IN ('usted', 'tu')),
  voz_id         text,
  avatar_id      text,
  rol_preferente text NOT NULL DEFAULT 'equilibrado'
                 CHECK (rol_preferente IN ('equilibrado', 'amigo', 'enfermero', 'consejero', 'puente')),
  actualizado_en timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contacto (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id          uuid NOT NULL REFERENCES persona (id) ON DELETE CASCADE,
  nombre_cifrado      bytea NOT NULL,
  relacion            text NOT NULL,
  telefono_cifrado    bytea,
  es_cuidador         boolean NOT NULL DEFAULT false,
  prioridad_emergencia smallint CHECK (prioridad_emergencia BETWEEN 1 AND 10),
  -- Lo que la persona autoriza que vea este contacto (p. ej. {"resumen_bienestar": true}).
  permisos            jsonb NOT NULL DEFAULT '{}'::jsonb,
  creado_en           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON contacto (persona_id);

ALTER TABLE persona
  ADD CONSTRAINT persona_representante_fk FOREIGN KEY (representante_legal_id) REFERENCES contacto (id) ON DELETE SET NULL;

CREATE TABLE consentimiento (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id             uuid NOT NULL REFERENCES persona (id) ON DELETE CASCADE,
  tipo                   text NOT NULL,
  version                text NOT NULL,
  otorgado_en            timestamptz NOT NULL DEFAULT now(),
  revocado_en            timestamptz,
  otorgado_por           text NOT NULL CHECK (otorgado_por IN ('persona', 'representante_legal')),
  otorgado_por_contacto_id uuid REFERENCES contacto (id) ON DELETE SET NULL
);
CREATE INDEX ON consentimiento (persona_id, tipo);

-- ── Cuentas, roles y dispositivos ────────────────────────────────────────────────────

CREATE TABLE cuenta (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo              text NOT NULL CHECK (tipo IN ('personal', 'familiar')),
  email             text NOT NULL UNIQUE CHECK (email = lower(email)),
  nombre            text NOT NULL,
  hash_contrasena   text NOT NULL,
  rol               text CHECK (rol IN ('supervisor_clinico', 'enfermera_enlace', 'gerontologo', 'guardia', 'admin_plataforma')),
  institucion       text,
  contacto_id       uuid REFERENCES contacto (id) ON DELETE CASCADE,
  activa            boolean NOT NULL DEFAULT true,
  intentos_fallidos integer NOT NULL DEFAULT 0,
  bloqueada_hasta   timestamptz,
  creada_en         timestamptz NOT NULL DEFAULT now(),
  CHECK ((tipo = 'personal' AND rol IS NOT NULL AND contacto_id IS NULL)
      OR (tipo = 'familiar' AND rol IS NULL AND contacto_id IS NOT NULL))
);

-- Qué personas ve cada profesional. El administrador de plataforma no tiene asignaciones:
-- gestiona altas y dispositivos, no contenido clínico.
CREATE TABLE asignacion_personal (
  cuenta_id    uuid NOT NULL REFERENCES cuenta (id) ON DELETE CASCADE,
  persona_id   uuid NOT NULL REFERENCES persona (id) ON DELETE CASCADE,
  asignada_en  timestamptz NOT NULL DEFAULT now(),
  asignada_por uuid REFERENCES cuenta (id),
  PRIMARY KEY (cuenta_id, persona_id)
);
CREATE INDEX ON asignacion_personal (persona_id);

CREATE TABLE sesion_acceso (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cuenta_id  uuid NOT NULL REFERENCES cuenta (id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  creada_en  timestamptz NOT NULL DEFAULT now(),
  expira_en  timestamptz NOT NULL,
  cerrada_en timestamptz,
  ip         text
);

CREATE TABLE dispositivo (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id    uuid NOT NULL REFERENCES persona (id) ON DELETE CASCADE,
  nombre        text NOT NULL,
  token_hash    bytea NOT NULL UNIQUE,
  creado_en     timestamptz NOT NULL DEFAULT now(),
  creado_por    uuid REFERENCES cuenta (id),
  revocado_en   timestamptz,
  ultimo_uso_en timestamptz
);
CREATE INDEX ON dispositivo (persona_id);

-- ── Conversación ─────────────────────────────────────────────────────────────────────

CREATE TABLE sesion_conversacion (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id      uuid NOT NULL REFERENCES persona (id) ON DELETE CASCADE,
  dispositivo_id  uuid REFERENCES dispositivo (id) ON DELETE SET NULL,
  inicio          timestamptz NOT NULL DEFAULT now(),
  fin             timestamptz,
  iniciada_por    text NOT NULL CHECK (iniciada_por IN ('persona', 'agente', 'sistema')),
  canal           text NOT NULL CHECK (canal IN ('texto', 'voz')),
  nivel_maximo    smallint NOT NULL DEFAULT 0 CHECK (nivel_maximo BETWEEN 0 AND 3),
  -- En emergencia el agente no cierra la conversación y responde con el protocolo de crisis.
  modo_emergencia boolean NOT NULL DEFAULT false,
  categorias_emergencia text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX ON sesion_conversacion (persona_id, inicio DESC);

CREATE TABLE turno (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sesion_id     uuid NOT NULL REFERENCES sesion_conversacion (id) ON DELETE CASCADE,
  persona_id    uuid NOT NULL REFERENCES persona (id) ON DELETE CASCADE,
  orden         integer NOT NULL,
  hablante      text NOT NULL CHECK (hablante IN ('persona', 'agente')),
  texto_cifrado bytea NOT NULL,
  -- Para el agente: cómo se produjo el texto que la persona recibió.
  origen        text NOT NULL CHECK (origen IN ('persona', 'modelo', 'modelo_regenerado', 'respuesta_segura', 'protocolo_emergencia')),
  audio_ref     text,
  creado_en     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sesion_id, orden),
  CHECK ((hablante = 'persona') = (origen = 'persona'))
);

-- ── Memoria ──────────────────────────────────────────────────────────────────────────

CREATE TABLE hecho_memoria (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id        uuid NOT NULL REFERENCES persona (id) ON DELETE CASCADE,
  capa              text NOT NULL CHECK (capa IN ('biografica', 'relacional', 'preferencias', 'salud')),
  contenido_cifrado bytea NOT NULL,
  privado           boolean NOT NULL DEFAULT false,
  origen_turno_id   uuid REFERENCES turno (id) ON DELETE SET NULL,
  vigente           boolean NOT NULL DEFAULT true,
  creado_en         timestamptz NOT NULL DEFAULT now(),
  actualizado_en    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON hecho_memoria (persona_id) WHERE vigente;

-- Dimensión del vector pendiente: depende del modelo de embeddings (decisión del Sprint 2).
-- El resumen va cifrado; el vector no puede cifrarse y no debe permitir reconstruir el texto.
CREATE TABLE embedding_memoria (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id     uuid NOT NULL REFERENCES persona (id) ON DELETE CASCADE,
  sesion_id      uuid REFERENCES sesion_conversacion (id) ON DELETE CASCADE,
  resumen_cifrado bytea NOT NULL,
  embedding      vector,
  creado_en      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON embedding_memoria (persona_id);

-- ── Salud ────────────────────────────────────────────────────────────────────────────

CREATE TABLE medicamento (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id               uuid NOT NULL REFERENCES persona (id) ON DELETE CASCADE,
  nombre_cifrado           bytea NOT NULL,
  proposito_simple_cifrado bytea,
  dosis_texto_cifrado      bytea NOT NULL,
  -- Horas locales "HH:MM" en la zona horaria de la persona.
  horarios                 jsonb NOT NULL DEFAULT '[]'::jsonb,
  vigente                  boolean NOT NULL DEFAULT true,
  creado_en                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON medicamento (persona_id) WHERE vigente;

CREATE TABLE evento_dosis (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  medicamento_id uuid NOT NULL REFERENCES medicamento (id) ON DELETE CASCADE,
  programada_en  timestamptz NOT NULL,
  confirmada_en  timestamptz,
  estado         text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'confirmada', 'omitida', 'sin_respuesta')),
  UNIQUE (medicamento_id, programada_en)
);

CREATE TABLE cita (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id          uuid NOT NULL REFERENCES persona (id) ON DELETE CASCADE,
  lugar               text NOT NULL,
  profesional_cifrado bytea,
  fecha               timestamptz NOT NULL,
  hoja_preparada_ref  text
);
CREATE INDEX ON cita (persona_id, fecha);

CREATE TABLE senal (
  id              bigserial PRIMARY KEY,
  persona_id      uuid NOT NULL REFERENCES persona (id) ON DELETE CASCADE,
  tipo            text NOT NULL,
  valor           numeric NOT NULL,
  origen_turno_id uuid REFERENCES turno (id) ON DELETE SET NULL,
  medido_en       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON senal (persona_id, tipo, medido_en DESC);

CREATE TABLE resultado_tamizaje (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id    uuid NOT NULL REFERENCES persona (id) ON DELETE CASCADE,
  instrumento   text NOT NULL,
  puntaje       numeric,
  items_cifrado bytea NOT NULL,
  aplicado_en   timestamptz NOT NULL DEFAULT now(),
  aplicado_por  text NOT NULL
);

-- ── Seguridad clínica ────────────────────────────────────────────────────────────────

CREATE TABLE evento_riesgo (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id         uuid NOT NULL REFERENCES persona (id) ON DELETE CASCADE,
  sesion_id          uuid REFERENCES sesion_conversacion (id) ON DELETE SET NULL,
  evidencia_turno_ids uuid[] NOT NULL DEFAULT '{}',
  nivel              smallint NOT NULL CHECK (nivel BETWEEN 1 AND 3),
  nivel_reglas       smallint NOT NULL CHECK (nivel_reglas BETWEEN 0 AND 3),
  nivel_clasificador smallint CHECK (nivel_clasificador BETWEEN 0 AND 3),
  fuente             text NOT NULL CHECK (fuente IN ('reglas', 'clasificador', 'agente', 'umbral_personal', 'sistema')),
  categorias         text[] NOT NULL DEFAULT '{}',
  -- Identificadores de reglas y razones del clasificador; el texto literal va cifrado aparte.
  detalle            jsonb NOT NULL DEFAULT '{}'::jsonb,
  fragmento_cifrado  bytea NOT NULL,
  accion             text NOT NULL,
  creado_en          timestamptz NOT NULL DEFAULT now(),
  -- TODO(clinico): plazo de acuse y cadena de contactos (Sprint 5).
  acuse_requerido    boolean NOT NULL,
  acusado_por        uuid REFERENCES cuenta (id),
  acusado_en         timestamptz,
  CHECK ((acusado_por IS NULL) = (acusado_en IS NULL))
);
CREATE INDEX ON evento_riesgo (persona_id, creado_en DESC);
CREATE INDEX ON evento_riesgo (creado_en DESC) WHERE acuse_requerido AND acusado_en IS NULL;

CREATE TABLE intervencion_guardian (
  id                      bigserial PRIMARY KEY,
  persona_id              uuid NOT NULL REFERENCES persona (id) ON DELETE CASCADE,
  sesion_id               uuid NOT NULL REFERENCES sesion_conversacion (id) ON DELETE CASCADE,
  turno_persona_id        uuid REFERENCES turno (id) ON DELETE SET NULL,
  intento                 smallint NOT NULL,
  etapa                   text NOT NULL CHECK (etapa IN ('reglas', 'clasificador', 'proveedor')),
  categorias              text[] NOT NULL DEFAULT '{}',
  reglas                  text[] NOT NULL DEFAULT '{}',
  texto_rechazado_cifrado bytea,
  accion                  text NOT NULL CHECK (accion IN ('regenerar', 'respuesta_segura')),
  creado_en               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON intervencion_guardian (sesion_id);

-- ── Supervisión clínica ──────────────────────────────────────────────────────────────

CREATE TABLE informe_sesion (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sesion_id         uuid NOT NULL UNIQUE REFERENCES sesion_conversacion (id) ON DELETE CASCADE,
  contenido_cifrado bytea NOT NULL,
  estado_validacion text NOT NULL CHECK (estado_validacion IN ('pendiente', 'valido', 'rechazado')),
  creado_en         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE informe_semanal (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id        uuid NOT NULL REFERENCES persona (id) ON DELETE CASCADE,
  semana            date NOT NULL,
  contenido_cifrado bytea NOT NULL,
  creado_en         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (persona_id, semana)
);

-- Cada cambio del plan es una versión nueva con autor y motivo; nada se sobrescribe.
CREATE TABLE plan_terapeutico (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id        uuid NOT NULL REFERENCES persona (id) ON DELETE CASCADE,
  version           integer NOT NULL CHECK (version >= 1),
  contenido_cifrado bytea NOT NULL,
  autor_id          uuid NOT NULL REFERENCES cuenta (id),
  motivo            text NOT NULL CHECK (length(trim(motivo)) >= 5),
  creado_en         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (persona_id, version)
);

CREATE TABLE actividad_comunitaria (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comuna      text NOT NULL,
  nombre      text NOT NULL,
  descripcion text NOT NULL DEFAULT '',
  horario     text,
  contacto    text,
  vigente     boolean NOT NULL DEFAULT true
);
CREATE INDEX ON actividad_comunitaria (comuna) WHERE vigente;

-- ── Uso de modelos (costo por persona al mes) ────────────────────────────────────────

CREATE TABLE uso_modelo (
  id             bigserial PRIMARY KEY,
  persona_id     uuid REFERENCES persona (id) ON DELETE SET NULL,
  sesion_id      uuid REFERENCES sesion_conversacion (id) ON DELETE SET NULL,
  tarea          text NOT NULL,
  proveedor      text NOT NULL,
  modelo         text NOT NULL,
  tokens_entrada integer NOT NULL DEFAULT 0,
  tokens_salida  integer NOT NULL DEFAULT 0,
  latencia_ms    integer NOT NULL,
  ok             boolean NOT NULL,
  error          text,
  creado_en      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON uso_modelo (persona_id, creado_en);

-- ── Auditoría (inmutable, incluso para el dueño de la tabla) ─────────────────────────

CREATE TABLE registro_auditoria (
  id           bigserial PRIMARY KEY,
  actor_tipo   text NOT NULL CHECK (actor_tipo IN ('personal', 'familiar', 'dispositivo', 'sistema')),
  actor_id     uuid,
  accion       text NOT NULL,
  recurso_tipo text NOT NULL,
  recurso_id   text,
  persona_id   uuid,
  motivo       text,
  detalle      jsonb NOT NULL DEFAULT '{}'::jsonb,
  creado_en    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON registro_auditoria (persona_id, creado_en DESC);

CREATE FUNCTION impedir_modificacion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'La tabla % no admite modificaciones ni borrados', TG_TABLE_NAME;
END $$;

CREATE TRIGGER registro_auditoria_inmutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON registro_auditoria
  FOR EACH STATEMENT EXECUTE FUNCTION impedir_modificacion();

-- ── Permisos de la aplicación ────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE ON
  persona, perfil_companero, contacto, consentimiento, cuenta, asignacion_personal, sesion_acceso,
  dispositivo, sesion_conversacion, hecho_memoria, medicamento, evento_dosis, cita,
  informe_sesion, actividad_comunitaria
TO vincular_app;

-- Derecho a olvido y a corregir: la memoria se puede borrar.
GRANT DELETE ON hecho_memoria, embedding_memoria, asignacion_personal TO vincular_app;
GRANT SELECT, INSERT ON embedding_memoria TO vincular_app;

-- Registros: solo insertar y leer.
GRANT SELECT, INSERT ON
  turno, senal, resultado_tamizaje, intervencion_guardian, informe_semanal, plan_terapeutico,
  uso_modelo, registro_auditoria, evento_riesgo
TO vincular_app;

-- Del evento de riesgo solo se puede registrar el acuse de recibo.
GRANT UPDATE (acusado_por, acusado_en) ON evento_riesgo TO vincular_app;

GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO vincular_app;

-- Un acuse de recibo, una vez registrado, no se cambia.
CREATE FUNCTION acuse_unico() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.acusado_en IS NOT NULL THEN
    RAISE EXCEPTION 'El evento de riesgo % ya tiene acuse de recibo', OLD.id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER evento_riesgo_acuse_unico
  BEFORE UPDATE ON evento_riesgo
  FOR EACH ROW EXECUTE FUNCTION acuse_unico();
