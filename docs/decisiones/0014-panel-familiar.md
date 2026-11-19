# 0014 · Panel familiar

Fecha: 18-11-2026 · Estado: aceptada

## Contexto

La especificación: la familia ve un "panel de bienestar resumido (no transcripciones), alertas acordadas, puede proponer recordatorios", y solo lo que la persona autoriza. Las cuentas familiares (ligadas a un contacto) y sus permisos (`resumen_bienestar`, `avisos_medicacion`, `hoja_control`) ya existían; faltaban la página y su API.

## Decisiones

1. **Página `/familia`**, pensada para el teléfono, con el mismo inicio de sesión. La administración crea el acceso desde la ficha del contacto (correo y contraseña inicial, entregada en persona).
2. **Solo categorías y cifras calculadas por el código**, nunca texto de las conversaciones ni de la IA: días con conversación (fila de 7 puntos), ánimo general (bien / regular / bajo), descanso, contactos con otras personas que la persona contó. Así nada de lo conversado puede llegar a la familia por error. Nunca: transcripciones, temas privados, plan, tamizajes, niveles de riesgo ni lecturas teóricas. Solo el primer nombre de la persona.
3. **Cada sección según el permiso de ese contacto**: bienestar, medicación (dosis confirmadas) y próximas citas con la hoja para el control. Sin ningún permiso, la página lo explica: lo decide la persona.
4. **Avisos**: los que recibió ese contacto en 30 días y si alguien acusó recibo (una cadena agotada o cancelada no se presenta como atendida).
5. **Propuestas**: la familia propone un recordatorio o un tema; el equipo clínico asignado lo acepta o descarta con una respuesta que la familia ve. Aceptar no lo aplica solo: el equipo lo incorpora al plan o a un recordatorio. Migración 0010.
6. Los números de emergencia vienen de la configuración verificada, no están escritos en la página.

`TODO(clinico)`: revisar los cortes del ánimo para la familia y la redacción de cada categoría.
