# Estado del desarrollo (traspaso entre sesiones)

Actualizado: 12-11-2026.

## Hecho (en `main`)
- Sprint 1 base técnica · Sprint 2 memoria y personaje · Sprint 3 voz · Sprint 4 enfermero digital.

## En revisión
- Sprint 5 escalamiento: PR #4 (rama `sprint-5`). Fusionar antes de seguir.

## Siguiente: Sprint 6 (supervisión clínica)
- Informe por sesión (JSON con esquema; `observado` vs `inferido`; toda cita textual verificada por código contra la transcripción; sin diagnósticos).
- Informe semanal por persona.
- Panel clínico web: bandeja de alertas y escalamientos, plan terapéutico editable, memoria, adherencia (APIs ya existen).
- Segundo factor (TOTP) para el personal clínico.

## Pendientes externos
- Claves: Gemini/Claude, Google Cloud (voz), ElevenLabs, Twilio; URL pública con HTTPS.
- Equipo clínico: los `TODO(clinico)` (reglas de riesgo, textos de crisis, protocolos, plazos, turnos).
- Abogado: transferencias internacionales (proveedores fuera de Chile).

## Convenciones
Ver `CLAUDE.md` y `docs/decisiones/`. Pruebas: `npm test` contra PostgreSQL real, sin modelos simulados.
