-- Un problema solo de tono (infantiliza, demasiado larga) en el segundo intento ya no termina en
-- la respuesta segura: se acepta la respuesta regenerada y queda registrada como observación.
-- Ver docs/decisiones/0019-guardian-tono-y-latencia.md.
ALTER TABLE intervencion_guardian DROP CONSTRAINT intervencion_guardian_accion_check;
ALTER TABLE intervencion_guardian
  ADD CONSTRAINT intervencion_guardian_accion_check
  CHECK (accion IN ('regenerar', 'respuesta_segura', 'aceptada_con_observacion'));
