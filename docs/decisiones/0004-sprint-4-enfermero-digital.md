# 0004 · Sprint 4: enfermero digital

Fecha: 12-11-2026 · Estado: aceptada

## Decisiones

1. **Los medicamentos los registra el equipo de salud** asignado (enfermera de enlace, gerontólogo o supervisor), tal como están indicados: nombre, para qué sirve en palabras de la persona, cómo se toma y a qué horas. Cifrados. Cambiar o suspender un medicamento anula sus dosis futuras y la agenda se regenera.

2. **Los recordatorios son plantillas, no texto del modelo.** Dicen exactamente lo indicado y nunca sugieren cambiar, saltar ni duplicar una dosis. Los remedios de la misma hora van en un solo recordatorio. La hora se dice como se habla ("las ocho de la mañana"). TODO(clinico): redacción.

3. **Ciclo en la base de datos, con la hora como parámetro**: hora indicada → recordatorio; +30 min sin confirmar → segundo aviso; +30 min más → "sin respuesta", señal de adherencia y aviso. Las transiciones usan `FOR UPDATE SKIP LOCKED`: con varios procesos no se repite un aviso. Las pruebas pasan la hora a cada función; no hay relojes falsos. TODO(clinico): plazos (`MEDICACION_SEGUNDO_AVISO_MIN`, `MEDICACION_SIN_RESPUESTA_MIN`).

4. **Agenda en la zona horaria de la persona** (`persona.zona_horaria`, por defecto `America/Santiago`): las horas locales se convierten con PostgreSQL, con y sin horario de verano.

5. **El aviso por "sin respuesta" va al cuidador solo si la persona lo autorizó** (`permisos.avisos_medicacion` del contacto). Si no autorizó a nadie, va al profesional asignado (primero la enfermera de enlace). El detalle no lleva nombres de medicamentos. Este sprint **crea** la notificación en la tabla `notificacion`; el Sprint 5 la envía por push, SMS o llamada.

6. **Si el servidor no pudo recordar a tiempo** (más de 60 min de atraso), la dosis queda `sin_registro` y no se escala: no sabemos si se la tomó y no se debe alarmar por una falla técnica.

7. **Confirmación por tres vías**: por voz (herramienta del agente), con el botón "Ya me lo tomé" y sin conexión (cola en la tablet que se envía al reconectar, con la hora en que se tomó). Una confirmación posterior a "sin respuesta" se acepta y queda marcada como tardía. Si la persona dice que no se lo tomará, se registra su motivo sin insistir.

8. **Recordatorios sin conexión**: la tablet guarda la agenda de 48 h con los textos listos. Si a la hora no llegó el recordatorio del servidor (margen de 90 s), suena con la voz del sistema de la tablet. En el prototipo web esto funciona mientras la página esté abierta; **la garantía real llega con la app de Expo (notificaciones locales del sistema operativo, Sprint 9).**

9. **El agente acompaña la rutina sin dar indicaciones**: ve nombre, para qué, hora y estado de los remedios de hoy, pero no las dosis. Si la persona olvidó una dosis o pregunta si tomar más, responde que eso lo decide su médico y ofrece anotar la pregunta para el control.

10. **Hoja de una página para el control**, generada sin modelo de lenguaje (no puede inventar): preguntas anotadas con las palabras de la persona, remedios con su registro de los últimos 30 días y lo que ella contó sobre su salud (sin lo privado ni lo no confirmado). La pueden ver la persona, su equipo asignado y el familiar que ella autorice (`permisos.hoja_control`).

11. **Planificador en el proceso del servidor** (cada 20 s medicación, cada 5 min memoria), sobre tareas idempotentes en la base. Para el piloto basta; Redis/BullMQ se evalúa en el Sprint 8. Se apaga con `PLANIFICADOR=no` y se reemplaza con `npm run medicacion:ciclo` en cron.

## Pendientes

- Envío de las notificaciones (Sprint 5).
- App Expo con notificaciones locales para la garantía sin conexión (Sprint 9).
- Panel de adherencia para la enfermera (Sprint 6, panel clínico).
- Hoja en PDF si el CESFAM lo prefiere (hoy es HTML imprimible).
