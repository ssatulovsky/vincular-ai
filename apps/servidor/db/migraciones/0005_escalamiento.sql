-- Sprint 5: escalamiento de punta a punta, parametrizable.
--
-- protocolo_escalamiento  qué cadena de avisos corresponde a cada circunstancia (tipo de evento,
--                         nivel, categoría, persona, día y hora), con su plazo de acuse por paso.
-- turno_guardia           quién cubre la guardia según día, hora, período y tipo de evento.
-- escalamiento            una cadena en curso para un evento concreto.
-- notificacion            cada mensaje (SMS o llamada) que sale, con su estado en el proveedor.

-- ── Teléfonos del personal (para SMS y llamadas) ─────────────────────────────────────
ALTER TABLE cuenta
  ADD COLUMN telefono_cifrado bytea,
  -- HMAC del teléfono normalizado: permite reconocer respuestas por SMS sin descifrar todo.
  ADD COLUMN telefono_hash bytea;
ALTER TABLE contacto ADD COLUMN telefono_hash bytea;
CREATE INDEX ON cuenta (telefono_hash) WHERE telefono_hash IS NOT NULL;
CREATE INDEX ON contacto (telefono_hash) WHERE telefono_hash IS NOT NULL;

-- ── Protocolos ───────────────────────────────────────────────────────────────────────
CREATE TABLE protocolo_escalamiento (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre         text NOT NULL,
  -- 'riesgo' (eventos de nivel 2 y 3) o 'dosis_sin_respuesta'.
  tipo_evento    text NOT NULL CHECK (tipo_evento IN ('riesgo', 'dosis_sin_respuesta')),
  -- Filtros: NULL = cualquiera. El protocolo que calza con más filtros gana; luego, la prioridad.
  nivel          smallint CHECK (nivel BETWEEN 1 AND 3),
  categoria      text,
  persona_id     uuid REFERENCES persona (id) ON DELETE CASCADE,
  dias           smallint[] CHECK (dias <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  hora_desde     time,
  hora_hasta     time,
  prioridad      integer NOT NULL DEFAULT 0,
  activo         boolean NOT NULL DEFAULT true,
  -- [{"destino": "cuidadores"|"equipo_asignado"|"guardia"|"cuenta"|"telefono", "canales": ["sms","llamada"],
  --   "esperarAcuseMin": 5, "permisoCuidador": "alertas_riesgo"|null, ...}]
  pasos          jsonb NOT NULL,
  version        integer NOT NULL DEFAULT 1,
  actualizado_por uuid REFERENCES cuenta (id),
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  CHECK ((hora_desde IS NULL) = (hora_hasta IS NULL))
);

-- ── Guardia ──────────────────────────────────────────────────────────────────────────
CREATE TABLE turno_guardia (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre           text NOT NULL,
  institucion      text,
  -- Una cuenta del personal (con teléfono) o un teléfono de una central externa.
  cuenta_id        uuid REFERENCES cuenta (id) ON DELETE CASCADE,
  telefono_cifrado bytea,
  telefono_hash    bytea,
  dias             smallint[] NOT NULL DEFAULT ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[] CHECK (dias <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  hora_desde       time NOT NULL DEFAULT '00:00',
  hora_hasta       time NOT NULL DEFAULT '23:59:59',
  vigente_desde    date NOT NULL DEFAULT current_date,
  vigente_hasta    date,
  -- Tipos o categorías que cubre ("riesgo", "riesgo:3", "dosis_sin_respuesta"…). Vacío = todo.
  cubre            text[] NOT NULL DEFAULT '{}',
  prioridad        integer NOT NULL DEFAULT 0,
  activo           boolean NOT NULL DEFAULT true,
  creado_en        timestamptz NOT NULL DEFAULT now(),
  CHECK (cuenta_id IS NOT NULL OR telefono_cifrado IS NOT NULL)
);

-- ── Cadenas en curso ─────────────────────────────────────────────────────────────────
CREATE TABLE escalamiento (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id       uuid NOT NULL REFERENCES persona (id) ON DELETE CASCADE,
  tipo_evento      text NOT NULL,
  nivel            smallint NOT NULL,
  categorias       text[] NOT NULL DEFAULT '{}',
  evento_riesgo_id uuid REFERENCES evento_riesgo (id) ON DELETE SET NULL,
  protocolo_id     uuid REFERENCES protocolo_escalamiento (id) ON DELETE SET NULL,
  -- Copia de los pasos al iniciar: cambiar el protocolo no altera cadenas en curso.
  pasos            jsonb NOT NULL,
  detalle          jsonb NOT NULL DEFAULT '{}'::jsonb,
  paso_actual      smallint NOT NULL DEFAULT 0,
  estado           text NOT NULL DEFAULT 'en_curso' CHECK (estado IN ('en_curso', 'acusado', 'agotado', 'cancelado')),
  proximo_paso_en  timestamptz,
  creado_en        timestamptz NOT NULL DEFAULT now(),
  acusado_en       timestamptz,
  acusado_por_cuenta uuid REFERENCES cuenta (id),
  acusado_por_contacto uuid REFERENCES contacto (id),
  acusado_via      text CHECK (acusado_via IN ('panel', 'sms', 'llamada')),
  cerrado_en       timestamptz
);
CREATE INDEX ON escalamiento (proximo_paso_en) WHERE estado = 'en_curso';
CREATE INDEX ON escalamiento (persona_id, creado_en DESC);

ALTER TABLE notificacion
  ADD COLUMN escalamiento_id uuid REFERENCES escalamiento (id) ON DELETE CASCADE,
  ADD COLUMN paso smallint,
  ADD COLUMN canal text CHECK (canal IN ('sms', 'llamada')),
  ADD COLUMN destino_telefono_cifrado bytea,
  ADD COLUMN destino_telefono_hash bytea,
  ADD COLUMN turno_guardia_id uuid REFERENCES turno_guardia (id) ON DELETE SET NULL,
  ADD COLUMN proveedor_id text,
  ADD COLUMN estado_proveedor text,
  ADD COLUMN intentos smallint NOT NULL DEFAULT 0,
  ADD COLUMN error text,
  ADD COLUMN entregada_en timestamptz;
ALTER TABLE notificacion DROP CONSTRAINT notificacion_check;
ALTER TABLE notificacion ADD CONSTRAINT notificacion_destino CHECK (destinatario_contacto_id IS NOT NULL OR destinatario_cuenta_id IS NOT NULL OR destino_telefono_cifrado IS NOT NULL);
CREATE INDEX ON notificacion (proveedor_id) WHERE proveedor_id IS NOT NULL;
CREATE INDEX ON notificacion (destino_telefono_hash, creada_en DESC) WHERE destino_telefono_hash IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON protocolo_escalamiento, turno_guardia, escalamiento TO vincular_app;

-- Un evento de riesgo puede acusarlo también un cuidador (por SMS o llamada), no solo el personal.
ALTER TABLE evento_riesgo ADD COLUMN acusado_por_contacto uuid REFERENCES contacto (id);
ALTER TABLE evento_riesgo DROP CONSTRAINT evento_riesgo_check;
ALTER TABLE evento_riesgo ADD CONSTRAINT evento_riesgo_acuse CHECK ((acusado_por IS NULL AND acusado_por_contacto IS NULL) = (acusado_en IS NULL));
GRANT UPDATE (acusado_por_contacto) ON evento_riesgo TO vincular_app;

-- ── Protocolos iniciales ─────────────────────────────────────────────────────────────
-- TODO(clinico): todos los plazos y cadenas son valores conservadores de partida. Se ajustan
-- por API (backoffice) sin tocar código. En nivel 3 el sistema NO llama al SAMU: guía a la
-- persona para que llame y avisa a la guardia para que actúe (decisión del 12-11-2026).
INSERT INTO protocolo_escalamiento (nombre, tipo_evento, nivel, pasos) VALUES
('Emergencia (nivel 3)', 'riesgo', 3, '[
  {"destino": "guardia", "canales": ["llamada", "sms"], "esperarAcuseMin": 0},
  {"destino": "cuidadores", "canales": ["llamada", "sms"], "esperarAcuseMin": 0, "permisoCuidador": null},
  {"destino": "equipo_asignado", "canales": ["sms"], "esperarAcuseMin": 5},
  {"destino": "guardia", "canales": ["llamada"], "esperarAcuseMin": 5},
  {"destino": "cuidadores", "canales": ["llamada"], "esperarAcuseMin": 10, "permisoCuidador": null}
]'),
('Alerta (nivel 2)', 'riesgo', 2, '[
  {"destino": "cuidadores", "canales": ["sms"], "esperarAcuseMin": 0, "permisoCuidador": "alertas_riesgo"},
  {"destino": "equipo_asignado", "canales": ["sms"], "esperarAcuseMin": 60},
  {"destino": "guardia", "canales": ["sms", "llamada"], "esperarAcuseMin": 60},
  {"destino": "equipo_asignado", "canales": ["llamada"], "esperarAcuseMin": 60}
]'),
('Dosis sin respuesta', 'dosis_sin_respuesta', NULL, '[
  {"destino": "cuidadores", "canales": ["sms"], "esperarAcuseMin": 120, "permisoCuidador": "avisos_medicacion"},
  {"destino": "equipo_asignado", "canales": ["sms"], "esperarAcuseMin": 240}
]');
