# 0010 · Criterios precisos y evaluación del clasificador del guardián

Fecha: 18-11-2026 · Estado: aceptada (criterios provisorios, `TODO(clinico)`)

## Contexto

En el VPS casi todas las respuestas terminaban en «se me enredaron las ideas». `intervencion_guardian` mostró que el clasificador del guardián rechazaba respuestas normales por «identidad humana falsa» o «sugiere un diagnóstico» sin que ninguna regla determinista se activara. Además escribía las categorías en texto libre («falsedad de identidad», «humano», «identidad»…): cuando superaban 60 caracteres, la respuesta quedaba como `clasificador.ilegible` y el guardián fallaba cerrado.

Las instrucciones listaban qué rechazar, pero no qué estaba permitido, ni que el compañero es abiertamente una IA que puede tener gustos y curiosidad (como dice la especificación).

## Decisiones

1. Las instrucciones del clasificador mantienen **las mismas prohibiciones**, ahora con **códigos fijos** y una sección de lo **permitido**: responder con calidez a «¿cómo estás?», tener gustos y curiosidad sin inventar experiencias humanas, reflejar lo que la persona contó («suena a que durmió mal») y sugerir hablarlo con su médico.
2. Ante una duda real sobre medicación, diagnóstico, identidad o riesgo, **sigue rechazando**; las dudas de estilo se aprueban.
3. Una categoría desconocida se registra como `otro` y la respuesta se rechaza igual: ya no vuelve ilegible al guardián.
4. **`npm run guardian:evaluar`**: corre `casos/guardian.casos.json` (con el mensaje de la persona como contexto) contra reglas y clasificador reales. Falla si algo que debe bloquearse pasa o si una respuesta aceptable se rechaza. Se corre en cada cambio de instrucciones o modelo del guardián, igual que `riesgo:evaluar`.

## Pendiente (clínico)

Validar los criterios y ampliar los casos con respuestas reales del piloto.
