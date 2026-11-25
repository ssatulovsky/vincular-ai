# Encargados de tratamiento (proveedores) — borrador

> Completar con los datos de cada contrato. El estado de cada acuerdo se marca en el panel, en Preparación del piloto.

| Proveedor | Qué hace | Qué datos recibe | Dónde [completar] | Acuerdo de tratamiento |
|---|---|---|---|---|
| Google (Gemini API) | Conversación, guardián, clasificador de riesgo, memoria, informes | Texto de las conversaciones, plan terapéutico, memoria relevante | [Completar] | Pendiente: sin uso para entrenamiento (plan de pago de la API), retención mínima |
| ElevenLabs | Transcripción (voz a texto) y síntesis de voz | Audio de la persona y texto que dice el compañero | [Completar] | Pendiente: retención cero si el plan lo permite |
| Simli (opcional, avatar) | Anima la cara del compañero | Retrato ficticio y audio de lo que dice el compañero (no la voz de la persona) | [Completar] | Pendiente |
| Twilio u otro (SMS y llamadas) | Avisos de escalamiento | Teléfonos y texto breve del aviso (sin detalle clínico) | [Completar] | Pendiente |
| Servidor (VPS) | Aloja la aplicación, la base de datos y LiveKit | Todos los datos (cifrados en la base) | [Completar: proveedor y país] | Pendiente |

LiveKit corre en el mismo servidor, así que el audio en tiempo real no pasa por terceros fuera de los proveedores de voz.
