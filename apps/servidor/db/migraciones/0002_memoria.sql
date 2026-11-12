-- Sprint 2: memoria estructurada y episódica, confirmación implícita y procesamiento de sesiones.

-- ── Hechos de memoria ────────────────────────────────────────────────────────────────
-- estado: los hechos que extrae el sistema quedan "por_confirmar" hasta que la persona los
-- confirma en una conversación siguiente (confirmación implícita). Los que ella dicta o corrige
-- quedan "confirmado".
ALTER TABLE hecho_memoria
  ADD COLUMN estado text NOT NULL DEFAULT 'confirmado' CHECK (estado IN ('por_confirmar', 'confirmado')),
  ADD COLUMN fuente text NOT NULL DEFAULT 'conversacion' CHECK (fuente IN ('conversacion', 'extraccion', 'persona', 'equipo')),
  ADD COLUMN sesion_origen_id uuid REFERENCES sesion_conversacion (id) ON DELETE SET NULL,
  -- Cita literal (cifrada) de lo que dijo la persona y que sostiene el hecho.
  ADD COLUMN cita_cifrada bytea,
  ADD COLUMN corregido_en timestamptz;

-- ── Memoria episódica ────────────────────────────────────────────────────────────────
-- Un resumen por sesión. La dimensión queda fija en 768: el modelo de embeddings configurado
-- debe entregar esa dimensión (Gemini permite pedirla con outputDimensionality).
ALTER TABLE embedding_memoria
  ALTER COLUMN embedding TYPE vector(768),
  ADD COLUMN temas_pendientes_cifrado bytea,
  ADD COLUMN proveedor text,
  ADD COLUMN modelo text;
CREATE UNIQUE INDEX embedding_memoria_sesion_unica ON embedding_memoria (sesion_id) WHERE sesion_id IS NOT NULL;
CREATE INDEX embedding_memoria_vector ON embedding_memoria USING hnsw (embedding vector_cosine_ops);

-- ── Procesamiento de sesiones (extracción de memoria) ────────────────────────────────
ALTER TABLE sesion_conversacion
  ADD COLUMN memoria_procesada_en timestamptz,
  ADD COLUMN memoria_intentos smallint NOT NULL DEFAULT 0,
  ADD COLUMN memoria_ultimo_error text,
  ADD COLUMN ultimo_turno_en timestamptz;

CREATE INDEX sesion_pendiente_memoria ON sesion_conversacion (ultimo_turno_en) WHERE memoria_procesada_en IS NULL;

-- La memoria se puede corregir y la aplicación necesita actualizar el resumen episódico.
GRANT UPDATE ON embedding_memoria TO vincular_app;
