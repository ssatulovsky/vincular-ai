# 0012 · Resumen de sesión con citas verificadas y lentes teóricas

Fecha: 18-11-2026 · Estado: aceptada

## Contexto

La especificación pide que cada conversación genere un resumen escrito para el psicólogo supervisor, con 10 puntos, frases textuales como evidencia y una separación explícita entre lo observado y lo inferido. CLAUDE.md agrega las reglas anti-alucinación: toda cita se verifica por código y ningún campo contiene diagnósticos. La decisión 0011 dejó las lentes teóricas activas por defecto.

## Decisiones

1. **Cuándo:** al cerrar la sesión, después de extraer la memoria. Si falla, el planificador lo retoma cada 5 minutos (máximo 3 intentos por fallas del proveedor). En tiempo real lo genera el planificador, porque el proceso del agente termina con la llamada.
2. **Modelo:** tarea `informes` (`IA_MODELO_INFORMES`); si no está configurada, usa el modelo de la conversación.
3. **Lo que pone el código, no el modelo:** fecha, duración, quién inició, canal, cantidad de intervenciones y nivel de riesgo (el del sistema; el modelo solo lo justifica).
4. **Validación por código antes de guardar como válido:**
   - Cada cita existe tal cual, dentro de un mismo turno, en lo que dijo la persona en esa sesión (se toleran mayúsculas, tildes y puntuación).
   - Todo texto entre comillas dentro de cualquier campo existe en la conversación.
   - Lo inferido, las hipótesis, las intervenciones y las lentes no contienen diagnósticos (`PATRON_DIAGNOSTICOS`). Lo observado solo nombra un diagnóstico si la persona lo dijo y se cita.
   - Una **lectura** de lente necesita al menos 2 sesiones previas que se le entregaron al modelo; si no, es una **observación**.
   - Solo lentes activas para el caso.
   Si falla, se regenera una vez con los errores; si vuelve a fallar, se guarda como **rechazado** con sus motivos y el panel no muestra el contenido.
5. **Contexto para recurrencias:** notas de los últimos 5 resúmenes válidos de la persona. No se entregan la formulación ni la hipótesis del plan (para no sesgar la observación), solo los objetivos y las técnicas indicadas.
6. **Lentes:** las 10 de la especificación; el supervisor desactiva cualquiera salvo la transferencia, desde el plan terapéutico (`lentes_desactivadas`).
7. **Acceso:** el equipo clínico asignado lo lee (auditado como `informe_sesion.leer`); solo el supervisor pide regenerar uno no válido. Contenido cifrado en reposo.

## Pendiente

- `TODO(clinico)`: revisar la estructura con resúmenes reales del piloto y validar las lentes con analistas independientes.
- Informe semanal, tamizaje conversacional y señal de dependencia (siguiente etapa).
