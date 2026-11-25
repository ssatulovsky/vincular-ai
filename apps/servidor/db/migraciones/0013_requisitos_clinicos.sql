-- Requisitos para conversar (decisión 0018): consentimiento vigente y evaluación clínica de
-- ingreso. Más el rol de psiquiatra y la supresión total de los datos de una persona (Ley 21.719).

-- ── Rol de psiquiatra ────────────────────────────────────────────────────────────────
ALTER TABLE cuenta DROP CONSTRAINT cuenta_rol_check;
ALTER TABLE cuenta ADD CONSTRAINT cuenta_rol_check
  CHECK (rol IN ('supervisor_clinico', 'psiquiatra', 'enfermera_enlace', 'gerontologo', 'guardia', 'admin_plataforma'));

-- ── Evaluación clínica de ingreso ────────────────────────────────────────────────────
-- La registra un profesional clínico asignado antes de que la persona converse con el
-- compañero. Vale la última; cada versión queda guardada (no se edita ni se borra).
CREATE TABLE evaluacion_ingreso (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id       uuid NOT NULL REFERENCES persona (id) ON DELETE CASCADE,
  -- apto · apto_con_resguardos (participa con indicaciones del equipo) · no_apto
  resultado        text NOT NULL CHECK (resultado IN ('apto', 'apto_con_resguardos', 'no_apto')),
  -- Criterios de exclusión revisados: {"psicosis_activa": false, ...} (lista en requisitos.ts).
  criterios        jsonb NOT NULL,
  -- Indicaciones o resguardos, cifrados (dato de salud).
  notas_cifradas   bytea,
  revisar_antes_de date NOT NULL,
  autor_id         uuid NOT NULL REFERENCES cuenta (id),
  creado_en        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON evaluacion_ingreso (persona_id, creado_en DESC);
GRANT SELECT, INSERT ON evaluacion_ingreso TO vincular_app;

-- ── Supresión total (derecho de supresión) ───────────────────────────────────────────
-- Borrar la persona arrastra todos sus datos (ON DELETE CASCADE). El registro de auditoría no
-- tiene llave hacia persona: la constancia de la supresión se conserva.
GRANT DELETE ON persona TO vincular_app;
