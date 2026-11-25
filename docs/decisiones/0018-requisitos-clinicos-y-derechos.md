# 0018 · Requisitos para conversar, evaluación de ingreso, psiquiatría y derechos sobre los datos

Fecha: 25-11-2026 · Estado: aceptada

## Contexto

La Ley 21.719 entra en vigencia el 1 de diciembre de 2026. Los datos de salud y emocionales son sensibles, así que su tratamiento exige consentimiento explícito. El sistema registraba el consentimiento pero no lo exigía para conversar. Además, ningún profesional decidía quién podía usar el compañero. Antes de la reunión con el responsable regional de salud mental se revisaron los obstáculos que un psiquiatra encontraría para adoptarlo: la responsabilidad por las alertas, la falta de criterios de exclusión, la incertidumbre regulatoria y los derechos sobre los datos.

## Decisiones

1. **Nadie conversa sin cumplir tres requisitos.** Se verifican al abrir una conversación, tanto en el modo clásico como en tiempo real:
   - consentimiento vigente y no revocado;
   - evaluación clínica de ingreso vigente, con resultado "apto" o "apto con resguardos";
   - la persona no está pausada ni dada de baja.
2. **Excepción de seguridad.** Si hay una emergencia (nivel 3) de las últimas 24 horas sin acuse humano, el compañero nunca se bloquea.
3. **La tablet bloqueada sigue conectada.** Los recordatorios de medicación y sus confirmaciones continúan, porque son un servicio de seguridad. La persona ve un mensaje tranquilo, sin culpas, con el SAMU 131 y el *4141. La tablet vuelve a consultar cada 10 minutos. El bloqueo queda en la auditoría.
4. **Evaluación clínica de ingreso.**
   - La registra un psiquiatra o un psicólogo supervisor asignado.
   - Antes debe marcar los 7 criterios de exclusión (lista conservadora, `TODO(clinico)`).
   - Con algún criterio presente no puede quedar en "apto": debe ser "apto con resguardos" (con indicaciones escritas) o "no apto".
   - Las notas van cifradas y la revisión es cada 6 meses por defecto.
   - Las evaluaciones no se editan: cada una queda guardada.
5. **Rol de psiquiatra.** Tiene los mismos permisos clínicos que el psicólogo supervisor con sus personas asignadas: plan, transcripción con motivo, evaluación de ingreso, alertas y medicación. También recibe los avisos del paso "equipo asignado". No gestiona cuentas, altas ni derechos sobre los datos.
6. **Derechos de acceso, portabilidad y supresión.**
   - La administración exporta todos los datos de una persona en un JSON legible: campos descifrados, sin credenciales ni hashes. El exportador es genérico, así que una tabla nueva queda incluida.
   - La supresión borra a la persona y todo lo suyo en cascada, incluidas las cuentas de su familia y su tablet.
   - Ambas acciones exigen un motivo, la supresión exige además escribir "SUPRIMIR", y las dos quedan en la auditoría, que sobrevive a la supresión.
   - El administrador ve contenido clínico solo en este caso, porque responde a una solicitud del titular.
7. **Preparación del piloto.** Una vista en el panel para la administración y los responsables clínicos, con dos partes:
   - **Lo que el sistema verifica solo:**
     - protocolos de riesgo de nivel 2 y 3;
     - guardia 24/7 (calcula las horas descubiertas, incluidos los turnos que cruzan la medianoche);
     - SMS y llamadas;
     - números de emergencia;
     - cada persona con consentimiento, evaluación, responsable clínico y cuidador.
   - **Lo que hay que marcar a mano:** convenio de guardia, protocolo validado, consentimiento revisado, evaluación de impacto, registro de actividades de tratamiento, acuerdos con proveedores y opinión ante el ISP.
8. **Celular.**
   - La app del compañero, el panel y la página familiar se adaptan a pantallas de celular.
   - Se pueden instalar como app (manifiesto con ícono).
   - La pantalla no se apaga mientras se conversa.

## Pendiente (no es código)

Ver `docs/legal/`: borradores para revisión de un abogado y del equipo clínico. Hay tres puntos críticos:
- quién cubre la guardia 24/7;
- los plazos de acuse del protocolo;
- los acuerdos de tratamiento con los proveedores, por la transferencia internacional.
