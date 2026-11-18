# 0009 · Nivel de razonamiento del modelo por tarea

Fecha: 17-11-2026 · Estado: aceptada

## Contexto

En la primera prueba en tiempo real el compañero respondió «tengo un problema para pensar» a «Te preguntaba cómo estás tú». `uso_modelo` mostraba todas las llamadas como exitosas, con 4 a 7 s por respuesta. En Gemini 3.x los tokens de razonamiento cuentan dentro de `maxOutputTokens`. La conversación pedía 600 y, sin indicar nivel, Gemini 3.8 Flash razona en `medium`: a veces gastaba el tope pensando y devolvía texto vacío, que el orquestador trataba como falla del proveedor.

## Decisiones

1. **`IA_RAZONAMIENTO_<TAREA>`** (`low`, `medium`, `high`, `predeterminado`), en configuración y no en el código. Claude lo ignora.
2. **Conversación en `low` por defecto**: responde en voz y cada segundo se nota. Riesgo, guardián y extracción quedan con el valor del modelo (criterio conservador; cambiarlos exige `npm run riesgo:evaluar`).
3. **Reserva de 2048 tokens** sobre el tope de texto en Gemini, para que el razonamiento no deje la respuesta vacía.
4. **Una respuesta vacía es un error del proveedor** y queda en `uso_modelo` con `finishReason` y los tokens de razonamiento, en vez de registrarse como éxito.

## Actualización 18-11-2026: modelo de respaldo

Ya con `low`, una llamada de conversación tardó más de 30 s y se cortó por tiempo: la persona esperó medio minuto para oír la respuesta segura.

5. **Respaldo de la conversación** (tarea `conversacion_respaldo`): si el modelo principal falla o se demora, se intenta una vez con el de respaldo antes de la respuesta segura. Por defecto es el modelo del guardián (rápido); se cambia con `IA_MODELO_CONVERSACION_RESPALDO`. Su respuesta pasa igual por el guardián. Ambos intentos quedan en `uso_modelo` y en `intervencion_guardian`.
6. **Esperas más cortas**: conversación 15 s (antes 30 s) y respaldo 10 s. Configurables con `IA_TIMEOUT_MS_<TAREA>`.

## Pendiente

- Medir en el VPS latencia y calidad de la conversación en `low` frente a `medium`.
