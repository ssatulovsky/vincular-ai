# 0009 · Nivel de razonamiento del modelo por tarea

Fecha: 17-11-2026 · Estado: aceptada

## Contexto

En la primera prueba en tiempo real el compañero respondió «tengo un problema para pensar» a «Te preguntaba cómo estás tú». `uso_modelo` mostraba todas las llamadas como exitosas, con 4 a 7 s por respuesta. En Gemini 3.x los tokens de razonamiento cuentan dentro de `maxOutputTokens`. La conversación pedía 600 y, sin indicar nivel, Gemini 3.8 Flash razona en `medium`: a veces gastaba el tope pensando y devolvía texto vacío, que el orquestador trataba como falla del proveedor.

## Decisiones

1. **`IA_RAZONAMIENTO_<TAREA>`** (`low`, `medium`, `high`, `predeterminado`), en configuración y no en el código. Claude lo ignora.
2. **Conversación en `low` por defecto**: responde en voz y cada segundo se nota. Riesgo, guardián y extracción quedan con el valor del modelo (criterio conservador; cambiarlos exige `npm run riesgo:evaluar`).
3. **Reserva de 2048 tokens** sobre el tope de texto en Gemini, para que el razonamiento no deje la respuesta vacía.
4. **Una respuesta vacía es un error del proveedor** y queda en `uso_modelo` con `finishReason` y los tokens de razonamiento, en vez de registrarse como éxito.

## Pendiente

- Medir en el VPS latencia y calidad de la conversación en `low` frente a `medium`.
