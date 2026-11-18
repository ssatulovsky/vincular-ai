# 0011 · Panel del equipo y lentes teóricas activas

Fecha: 18-11-2026 · Estado: aceptada

## Contexto

El backend clínico tenía las API de altas, plan terapéutico, alertas y transcripciones, pero solo existían las pantallas de la tablet y del diseño del compañero. El responsable del producto pidió la administración de pacientes y el backend clínico de la especificación «Vínculo: plataforma agéntica psicosocial y terapéutica».

## Decisiones

1. **Un solo panel (`/panel`) con vistas por rol**, sobre el modelo de permisos existente (`decidirPermiso`):
   - **Administración**: altas, datos, contactos, códigos de tablet, equipo asignado, consentimiento y cuentas. **Nunca contenido clínico**, ni siquiera cuántas alertas tiene una persona.
   - **Clínicos asignados** (supervisor, enfermera de enlace, gerontólogo): sus personas, ordenadas por quién necesita atención (alertas sin acuse, nivel de riesgo de la semana); resumen, plan terapéutico, medicación y citas, memoria. Solo el supervisor edita el plan y abre transcripciones (con motivo registrado).
   - **Guardia**: todas las personas, solo para las alertas.
2. Permisos nuevos: `persona.ver_datos` (administración o clínico asignado) y `persona.editar` (administración).
3. **Los contactos no se borran: se dan de baja** (migración 0007). Forman parte del historial de alertas; un contacto de baja no recibe avisos y su cuenta familiar se cierra.
4. Consentimiento con vigencia de 6 meses por defecto (la especificación pide revisarlo cada 6 meses y ante cambios cognitivos).
5. **Lentes teóricas activas por defecto** en el análisis de las conversaciones (decisión del responsable del producto; antes previstas para la fase 2). Se mantienen las reglas de la especificación: solo para el profesional, cada lectura con su fragmento literal y marcada como hipótesis, la transferencia hacia el agente se analiza siempre, varias sesiones antes de proponer una lectura, y el supervisor puede desactivar una lente por caso. Se implementan en la etapa de informes de sesión. `TODO(clinico)`: validar la concordancia con analistas en el piloto, como pide la especificación.

## Siguiente etapa

Resumen de sesión de 10 puntos (observado/inferido, citas verificadas contra la transcripción, sin diagnósticos) con las lentes; después el informe semanal, el tamizaje conversacional (GDS-15, UCLA-3) y la señal de dependencia.

## Fuera de alcance

El diálogo con un ser querido fallecido no se construye en el producto general: es una intervención clínica caso a caso indicada por un comité.
