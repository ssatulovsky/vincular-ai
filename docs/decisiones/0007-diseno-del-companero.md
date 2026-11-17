# 0007 · Diseño del compañero: género, edad, voz y retrato

Fecha: 17-11-2026 · Estado: aceptada

## Contexto

La especificación pide que la persona diseñe a su interlocutor (identidad, forma de hablar, voz y aspecto) y que el sistema proponga 3 imágenes para elegir. En la primera prueba en el VPS la voz quedó fija para todos; cada persona necesita la suya. Decisiones del responsable clínico (17-11-2026): retratos generados y diseño desde la tablet y desde el panel.

## Decisiones

1. **Pantalla `/companero`, un paso por pantalla**: género, edad aparente (joven, adulta, mayor), nombre, trato y modismos, rasgos de personalidad (hasta 3) y rol, voz con muestra (filtrada por género y ordenada por cercanía de edad) y velocidad, retrato, resumen. Funciona con el código de la tablet o con una cuenta del equipo (que elige entre sus personas asignadas; `GET /api/mis-personas`).
2. **Retratos generados con Gemini** (tarea `imagenes`, API Interactions de Google): 3 propuestas por ronda de personas ficticias, chilenas, con expresión serena y un entorno a elección (cocina, jardín, living). La instrucción exige que no se parezcan a personas reales ni famosas y que no tengan texto. Las imágenes llevan la marca SynthID de Google.
3. **Sin fotos subidas**: no se puede usar la cara de una persona real (ni de un fallecido: eso está fuera del producto).
4. **Costo acotado**: `AVATAR_RONDAS_POR_DIA` (4 por defecto) y límite de frecuencia por IP. Cada retrato queda en `uso_modelo`, con el error recortado si falla.
5. **El retrato elegido debe ser de esa persona**: lo valida el servidor al guardar el perfil (tablet y equipo). Las imágenes solo las ven la tablet de la persona y su equipo asignado. No se cifran porque no son datos de salud ni de una persona real.
6. **El agente conoce su género y edad aparente** para la concordancia ("estoy contenta"), y la instrucción insiste en que eso no le da una vida humana.
7. **Catálogo de voces con `edad`**, para filtrar.

## Pendiente

- La API Interactions para imágenes no se pudo probar sin una clave: la primera prueba real es en el VPS (el error queda en `uso_modelo`).
- Borrar los retratos no elegidos pasados 30 días. TODO.
- Validar con personas mayores en el co-diseño: retrato realista frente a ilustrado (valle inquietante) y el trío de voces.
