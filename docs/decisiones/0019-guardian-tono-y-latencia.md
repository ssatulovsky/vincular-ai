# 0019 — Guardián: falsos positivos de tono y latencia

**Fecha:** 2026-11-26

## Contexto

En el VPS, 3 de 5 turnos de voz terminaron en la respuesta segura y la respuesta tardó entre 8 y 14 s.
`intervencion_guardian` mostró que el clasificador (gemini-3.5-flash-lite) rechazaba respuestas por
`infantiliza` y `se_hace_pasar_por_humano`. Cada rechazo cuesta otra generación (2–6 s) y otra
revisión (~1 s), y si el segundo intento también se rechaza, la persona recibe una frase genérica.

## Decisión

1. **Instrucciones más precisas.**
   - `infantiliza` se define con ejemplos: apodos de niño, felicitar por obediente, tono de profesor, regaño.
   - `se_hace_pasar_por_humano` se limita a afirmar ser persona, negar ser IA o prometer presencia física.
   - Pasan a estar explícitamente permitidos:
     - expresar alegría o comprensión como compañero digital;
     - los diminutivos habituales del habla chilena;
     - felicitar logros de adulto.
2. **El tono no termina en la respuesta segura.**
   - `infantiliza` y `demasiado_larga` se regeneran una vez.
   - Si el segundo intento solo tiene problemas de tono, se acepta y queda en `intervencion_guardian` con la acción `aceptada_con_observacion` (migración 0015), para la auditoría clínica.
   - Cualquier problema de seguridad (medicación, diagnóstico, identidad, riesgo, etc.) sigue igual: respuesta segura.
3. **Casos nuevos** en `guardian.casos.json`: 5 respuestas cálidas que deben aprobarse y 2 que deben bloquearse por identidad.

## Pendiente

- `TODO(clinico)`: validar con el equipo clínico qué cuenta como infantilizar en el habla chilena.
- Correr `npm run guardian:evaluar` en el VPS (requiere la clave del modelo) tras desplegar.
- Latencia restante: acuse inmediato con frases fijas y revisión por frases en paralelo a la voz. Esto se propone aparte y requiere visto bueno clínico.
