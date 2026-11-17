# 0008 · Conversación en tiempo real con LiveKit

Fecha: 17-11-2026 · Estado: aceptada

## Contexto

El modo manos libres (PR #14) ya evita tocar la pantalla, pero sigue siendo por turnos: la tablet graba hasta un silencio, envía el audio completo, espera la respuesta entera y la reproduce. La persona nota la espera y no puede interrumpir con naturalidad. El responsable clínico pidió una conversación "lo más natural posible" con un compañero animado, sin suscripciones nuevas mientras no haya ventas.

## Decisiones

1. **LiveKit autoalojado** (servidor libre, v1.13.11) en el mismo VPS, junto con **LiveKit Agents para Node** (v1.10). No se usa LiveKit Cloud: sin costo fijo y el audio no pasa por un tercero más.
2. **El paso de lenguaje es el orquestador de siempre**, no un modelo conectado directo. El agente sobrescribe `llmNode` y llama a `orquestador.procesarTurno`: detector de riesgo, guardián, memoria, plan terapéutico y registro de turnos siguen iguales. Ninguna respuesta sale sin guardián.
3. **Sin generación anticipada** (`preemptiveGeneration` desactivado) y la respuesta se habla completa después del guardián. Se pierde algo de latencia a cambio de no hablar nada que el guardián no haya aprobado.
4. **Voz**: ElevenLabs en streaming, tanto para escuchar (`scribe_v2_realtime`) como para hablar (la voz que eligió la persona; si es de otro proveedor, la primera de ElevenLabs disponible). Detección de voz con Silero en el servidor.
5. **Fin de turno para personas mayores**: silencio mínimo de 1,2 s y máximo de 4 s (`TIEMPO_REAL_FIN_TURNO_MIN_S` / `_MAX_S`), configurable. La interrupción por voz exige 0,6 s de habla sostenida. `TODO(clinico)`: calibrar en el co-diseño.
6. **Seguridad del acceso**: solo la tablet (permiso `conversacion.usar`) pide una sala; el servidor firma un permiso de 10 minutos con la identidad `persona-<id>` y despacha al agente en el mismo permiso. El agente rechaza a cualquier participante cuya identidad no calce con los atributos firmados. Cada sala queda en `registro_auditoria`.
7. **Emergencias**: la sesión se abre con el mismo `abrirSesionConEmergencia` del modo por turnos; la tablet recibe los números de emergencia por el canal de datos y muestra el aviso si el turno entra en modo emergencia. Al terminar, la sesión no se cierra si hay una emergencia en curso.
8. **Respaldo automático**: si el servidor no ofrece tiempo real o la conexión falla, la tablet sigue con el modo manos libres por turnos.
9. **Recordatorios de medicación**: al aparecer uno, el compañero se calla y el micrófono se cierra hasta que la persona confirma.

## Límites conocidos

- Con los modelos `eleven_v4_*` el plugin de ElevenLabs usa la API de diálogo, que **ignora la velocidad** elegida: en tiempo real suena a la velocidad natural de la voz.
- La latencia real (fin del habla → inicio de la respuesta) se mide en el VPS; la meta de la especificación es bajo 2 s.
- Requiere abrir TCP 7881 y UDP 50000-60000. Redes que bloqueen UDP usan TCP 7881; sin servidor TURN, algunas redes muy cerradas podrían no conectar (vuelve al modo por turnos).

## Siguiente paso

Avatar animado de bajo costo sobre la misma sala de LiveKit (Simli o HeyGen LiveAvatar LITE, ambos con integración para LiveKit), en una prueba acotada.
