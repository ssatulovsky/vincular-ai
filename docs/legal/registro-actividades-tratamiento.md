# Registro de actividades de tratamiento (borrador)

> Borrador para revisión legal. Responsable: InnovAgile Group SpA, RUT 77.798.901-4.

| Actividad | Finalidad | Datos | Titulares | Base | Conservación | Encargados / transferencias |
|---|---|---|---|---|---|---|
| Conversación con el compañero | Acompañamiento y apoyo psicosocial | Texto de la conversación (cifrado), memoria (hechos y resúmenes) | Persona mayor | Consentimiento explícito | Detalle 6 meses; resumen mientras dure el servicio | Modelos de lenguaje; voz (transcripción y síntesis); avatar opcional |
| Detección de riesgo y escalamiento | Proteger la vida y la salud | Fragmento literal (cifrado), nivel, categorías, avisos y acuses | Persona; cuidadores; guardia | Consentimiento; interés vital [validar] | [Completar: plazo clínico-legal] | Mensajería (SMS y llamadas) |
| Enfermero digital | Adherencia a la medicación, citas | Medicamentos, horarios, confirmaciones | Persona | Consentimiento | Mientras esté vigente + [completar] | Voz (recordatorio hablado) |
| Supervisión clínica | Plan terapéutico, informes | Informes de sesión, plan, evaluaciones de ingreso, tamizajes (cifrados) | Persona | Consentimiento | [Completar: plazo de ficha clínica, Ley 20.584] | Modelos de lenguaje (generación de informes) |
| Panel familiar | Tranquilidad de la familia | Resumen de bienestar sin contenido | Persona; familiar | Consentimiento (autorización por contacto) | Mientras dure la autorización | — |
| Auditoría | Seguridad y rendición de cuentas | Quién accedió a qué, cuándo y por qué | Equipo; persona | Obligación legal / interés legítimo [validar] | [Completar] | — |
| Medición de costos | Sostenibilidad del servicio | Tokens y minutos por persona, sin contenido | Persona (seudonimizada) | Interés legítimo [validar] | 24 meses [validar] | — |

**Medidas de seguridad:** cifrado en reposo (AES-256-GCM) de conversaciones y datos de salud, TLS en tránsito, control de acceso por rol en una función única probada, auditoría de accesos a transcripciones y planes, y exportación y supresión completas.
