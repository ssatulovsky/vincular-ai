-- Contactos dados de baja: no se borran porque forman parte del historial de alertas (a quién
-- se avisó, quién acusó recibo). Un contacto de baja no recibe avisos, su cuenta familiar se
-- desactiva y deja de aparecer en la ficha.
ALTER TABLE contacto ADD COLUMN dado_de_baja_en timestamptz;
CREATE INDEX contacto_activos ON contacto (persona_id) WHERE dado_de_baja_en IS NULL;
