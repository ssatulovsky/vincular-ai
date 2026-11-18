# 0015 · Informe para consulta

Fecha: 18-11-2026 · Estado: aceptada

## Contexto

La especificación lista un "informe para consulta": antes de un control médico o psicológico, síntesis del período, cambios relevantes y preguntas de la persona, para el profesional tratante, con autorización. CLAUDE.md agrega que los temas marcados como privados nunca aparecen en informes que no sean del supervisor.

## Decisiones

1. **Desde una cita**, en la pestaña Medicación y citas: «Informe para el profesional». Lo genera el equipo clínico asignado.
2. **Autorización obligatoria**: a quién se entrega y de qué forma (verbal o escrita), más la confirmación explícita. Queda en el documento y en `registro_auditoria` (destinatario, forma, cuántos registros se omitieron por privados).
3. **Sin modelo de lenguaje**: lo arma el código con lo registrado y validado (preguntas anotadas, medicación y adherencia de 30 días, lo observado sobre salud y vida diaria en los resúmenes válidos con sus citas textuales, ánimo y contacto frente a la línea base, alertas y tamizajes). No puede inventar.
4. **Nunca incluye** transcripciones, hipótesis, inferencias, plan, lecturas teóricas ni temas privados. El filtro de lo privado es deliberadamente estricto: se omite lo que viene del mismo turno que un hecho privado, lo que comparte su cita o una palabra distintiva del tema. Si se omitió algo, el documento lo dice.
5. **Período**: desde el control anterior, con un máximo de 90 días; si no hubo control anterior, los últimos 30 días.
6. Documento A4 imprimible, con política de contenido que no permite scripts y todo el texto escapado.
