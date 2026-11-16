# 0005 · Sprint 5: escalamiento

Fecha: 12-11-2026 · Estado: aceptada

## Decisiones del equipo (12-11-2026)

1. **La guardia se parametriza según las circunstancias**: turnos por día, hora, período de vigencia, tipo de evento y prioridad, con una cuenta del personal o el teléfono de una central externa.
2. **Twilio**, con SMS y llamada como mínimo.
3. **Los plazos se parametrizan según la circunstancia**: no es igual una emergencia que algo trivial.
4. **En nivel 3 el sistema guía a la persona y avisa a la guardia; no llama al SAMU por su cuenta** (al menos en esta etapa).

## Cómo quedó

- **Protocolos** (`protocolo_escalamiento`): para cada tipo de evento (riesgo, dosis sin respuesta) y, opcionalmente, nivel, categoría, persona, días y franja horaria, una cadena de pasos. Cada paso dice a quién (cuidadores, equipo asignado, guardia de turno, una cuenta o un teléfono), por qué canales (SMS, llamada) y cuántos minutos esperar un acuse antes del siguiente (0 = en paralelo). Gana el protocolo más específico; luego, la prioridad. Se editan por API con motivo en la auditoría; una cadena en curso conserva los pasos con que empezó.
- **Reglas que no se pueden saltar**: un protocolo de riesgo siempre incluye a la guardia; en emergencia el primer paso espera como máximo 10 minutos; si no hay protocolo para un riesgo, se usa una cadena de respaldo que empieza por la guardia.
- **Protocolos iniciales** (TODO(clinico), ajustables sin tocar código):
  - Nivel 3: guardia (llamada y SMS), cuidadores y equipo de inmediato; a los 5 min, guardia de nuevo; a los 10, cuidadores por llamada.
  - Nivel 2: cuidadores autorizados y equipo por SMS; a los 60 min, guardia; luego, llamada al equipo.
  - Dosis sin respuesta: cuidadores autorizados por SMS; a las 2 h, el equipo.
- **Permisos de los cuidadores**: en riesgo vital (nivel 3) se avisa a todos los cuidadores, como la persona sabe desde el onboarding; en nivel 2, solo a los que ella autorizó (`alertas_riesgo`); por remedios, a los autorizados para eso (`avisos_medicacion`).
- **Acuse humano** que detiene la cadena: desde el panel (alerta o escalamiento), respondiendo "1" al SMS o presionando 1 en la llamada. El evento de riesgo queda acusado por esa cuenta o ese cuidador.
- **Nadie espera a quien no recibió nada**: si todos los mensajes de un paso fallan (o no hay a quién avisar), se pasa al siguiente de inmediato. Los errores de conexión con Twilio se reintentan tres veces.
- **"Sin respuesta tras evento de riesgo"**: si durante una emergencia la persona deja de escribir o hablar (`ESCALAMIENTO_EMERGENCIA_SIN_RESPUESTA_MIN`, 10 min), la cadena se acelera y los mensajes lo dicen.
- **Los mensajes no llevan detalles clínicos** (viajan por canales no cifrados): quién, qué tan urgente y qué hacer. En emergencia piden llamar a la persona y, si corresponde, al SAMU. Los números de emergencia vienen de la configuración. TODO(clinico): redacción.
- **Webhooks de Twilio validados con su firma** sobre la URL pública (`BASE_URL_PUBLICA`). Sin URL pública, los mensajes salen igual pero no se puede responder con "1".
- **Teléfonos cifrados** y con un HMAC para reconocer respuestas; en el panel se muestran enmascarados.
- **Ejecución inmediata**: una cadena nueva no espera el ciclo del planificador (15 s); el orquestador lo despierta.

## Pendientes

- Cuenta de Twilio, número chileno de origen y URL pública con HTTPS para los webhooks.
- Definir con el equipo clínico los protocolos, plazos, turnos y la redacción de los mensajes.
- Notificaciones push (cuando exista la app del panel).
- Revisar con abogado el envío de datos a Twilio (transferencia internacional, sección 9).
