# 0017 · Simli como proveedor principal del avatar animado

Fecha: 18-11-2026 · Estado: aceptada · Corrige la decisión 0016

## Contexto

La decisión 0016 descartó Simli porque LiveKit no publica su complemento para Node. Fue un error: no tener complemento no significa no poder usarlo. El complemento oficial de Python (`livekit-plugins-simli` 1.8) solo hace dos llamadas a la API de Simli y envía la voz por el canal estándar de LiveKit que ya usamos con LemonSlice.

Precios publicados de Simli (noviembre de 2026; verificar al contratar):

| Plan | Mensual | Minutos | Minuto extra | Caras propias nuevas al mes |
|---|---|---|---|---|
| Gratis | USD 0 | 50 | — | 0 (solo caras del catálogo) |
| Hobby | USD 10 | 1.000 | USD 0,01 | 1 |
| Pro | USD 49 | 5.500 | USD 0,0095 | 5 |
| Scale | USD 249 | 27.500 | USD 0,009 | 25 |

Con 20 min/día por persona (~600 min/mes) es del orden de 10 a 20 veces más barato que LemonSlice.

## Decisiones

1. **`AVATAR_ANIMADO=simli` como opción recomendada**; LemonSlice queda como alternativa por configuración. El flujo del complemento de Python se replicó en `src/agente/avatarSimli.ts`. Hay una diferencia a propósito: si Simli rechaza la sesión se lanza un error en vez de solo registrarlo, para volver a la voz directa (decisión 0016).
2. **Cara propia desde el retrato elegido.** Simli necesita construirla antes (reencuadre y luego construcción, unas 4 horas) y el plan limita cuántas caras nuevas hay al mes. Por eso:
   - se pide recién **cuando la persona conversa** con ese retrato, en segundo plano, para no gastar cupo en retratos que nadie usa;
   - una "reserva" en la base evita que dos conversaciones simultáneas gasten dos caras;
   - si falla, o Simli responde 403 (sin cupo), se reintenta a las 24 horas;
   - el estado se consulta al empezar cada conversación y se muestra en la cabecera de la ficha del panel.
3. **Cara de prueba** (`SIMLI_CARA_PRUEBA`, una cara del catálogo de Simli) mientras la propia no está lista. Sirve para probar con el plan gratuito, que no crea caras propias. Es otra cara, no el retrato de la persona: solo para pruebas, no para el piloto.
4. **Sesiones acotadas**: `maxSessionLength` es lo que queda del tope diario, con un máximo de 30 min; `maxIdleTime` = `AVATAR_ANIMADO_INACTIVIDAD_S`. Al terminar la conversación, el agente saca al avatar de la sala para que no siga cobrando mientras espera su inactividad.
5. **Video cuadrado** (768×768) para el círculo de la tablet. Simli arma la figura de la cintura hacia arriba, y `SIMLI_ZOOM` acerca la cámara si la cara se ve pequeña.
6. A Simli se envía el nombre técnico `vincular-<id del retrato>`, nunca datos de la persona.

## Privacidad

Igual que en la 0016: el proveedor recibe el retrato (persona ficticia) y el audio de lo que dice el compañero, nunca la voz de la persona. `TODO(legal)`: acuerdo de tratamiento de datos con Simli (no uso para entrenamiento, retención mínima) antes de usarlo con personas reales.
