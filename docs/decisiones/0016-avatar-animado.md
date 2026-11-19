# 0016 · Avatar animado de bajo costo

Fecha: 18-11-2026 · Estado: aceptada (apagado por defecto; se prende por configuración)

## Contexto

La descripción del proyecto pide "imagen realista y voz". El MVP ya tiene el retrato que la persona eligió (persona ficticia generada, decisión 0007) que "respira" y se ilumina con la voz. Se pidió un avatar animado de bajo costo sobre la conversación en tiempo real (LiveKit, decisión 0008). Restricción del proyecto: sin suscripciones mientras no haya ventas.

## Opciones revisadas (precios publicados, noviembre de 2026; verificar al contratar)

| Proveedor | Desde la cara que ya existe | Plugin LiveKit para Node | Costo publicado |
|---|---|---|---|
| **LemonSlice** | Sí: una imagen, sin entrenamiento, se sube en cada sesión | Sí (`@livekit/agents-plugin-lemonslice`) | Plan desde USD 8/mes con 41 min; minuto extra USD 0,22 |
| LiveAvatar (HeyGen), modo LITE | Avatar personalizado dentro de HeyGen (foto o video con consentimiento) | Sí | 1 crédito/min ≈ USD 0,10–0,13/min en planes de entrada; USD 0,01/min solo en contratos empresa |
| Anam | Sí, una imagen | Sí | Gratis 30 min/mes pero conversaciones de máximo 3 min; pago desde USD 12/mes |
| Simli | Sí | **No** (solo Python) | — |

## Decisiones

1. **LemonSlice detrás de una configuración**: `AVATAR_ANIMADO=ninguno|lemonslice` y `LEMONSLICE_API_KEY` en el `.env`. Es el único que anima directamente el retrato elegido, sin crear ni entrenar avatares en otra plataforma, con plugin para nuestro agente y la entrada más barata. Cambiar de proveedor después es cambiar una clase en `src/agente/avatar.ts`.
2. **Apagado por defecto.** Sin configuración, todo sigue como hoy: retrato que respira, sin costo.
3. **Nunca es una dependencia.** La voz del compañero pasa por el proveedor para sincronizar la boca, así que se agregaron tres resguardos. Si el avatar no logra empezar, la conversación arranca con voz directa. Si no aparece con video en 20 s, o se desconecta a mitad de la conversación (también por inactividad), el agente vuelve a publicar su voz directa y la tablet vuelve al retrato.
4. **En una emergencia (modo de emergencia abierto) no se enciende.** Hay menos piezas que puedan fallar mientras se activa la ayuda.
5. **Tope diario por persona** (`AVATAR_ANIMADO_MAX_MINUTOS_DIA`, 20 por defecto, hora de Chile). Pasado el tope, queda el retrato. La inactividad (`AVATAR_ANIMADO_INACTIVIDAD_S`, 45 s) cierra el avatar para que no cobre en silencio.
6. **Medición de costo**: tabla `uso_avatar` (solo tiempos, sin imagen, audio ni texto). El reporte mensual de costos suma minutos y USD por persona; el precio por minuto va en `config/precios-modelos.json` (`porMinuto`), nunca en el código.
7. **Gestos**: indicaciones fijas de movimiento sereno y adulto (sin gestos exagerados ni coquetos). No influyen en lo que se dice: el texto sigue saliendo del orquestador y del guardián.

## Costo esperado (a validar en el piloto)

Con el tope de 20 min/día y uso diario, son hasta ~600 min por persona al mes. A la tarifa de minuto extra publicada (USD 0,22) eso es del orden de USD 130 por persona al mes, muy por sobre el resto del sistema. Por eso:
- se recomienda probarlo con **pocas personas** y un plan de entrada, comparando con el retrato que respira (pregunta abierta del "valle inquietante");
- para escalar habría que negociar precio por volumen o evaluar otro proveedor, que se cambia por configuración.

## Privacidad (revisar con abogado: Ley 21.719, transferencia internacional)

- Al proveedor se envían el **retrato** (persona ficticia, no un dato personal) y el **audio de lo que dice el compañero**. Ese audio puede contener datos personales y de salud de la persona ("¿cómo sigue su rodilla?").
- **La voz de la persona no se envía.**
- `TODO(legal)`: antes de activarlo con personas reales, acuerdo de tratamiento de datos con el proveedor, con no uso para entrenamiento y retención mínima, e información en el consentimiento.
