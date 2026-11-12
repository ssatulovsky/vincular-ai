# CLAUDE.md — Vincular-IA

## Convenciones del repositorio (acordadas en el Sprint 1)

- **Código, comentarios y tablas en español**; producto en español de Chile.
- Node.js 22, TypeScript estricto, Fastify 5, PostgreSQL 16 + pgvector. Monorepo con npm workspaces (`paquetes/*`, `apps/*`).
- **Modelos**: Gemini por defecto, Claude intercambiable por configuración y por tarea (`IA_PROVEEDOR_<TAREA>`, `IA_MODELO_<TAREA>`). Nunca nombres de modelo en el código. **Nada de modelos simulados**, ni en desarrollo ni en pruebas.
- Pruebas contra PostgreSQL real (`npm test`). Todo lo que toque riesgo, escalamiento, memoria y permisos lleva pruebas.
- Cada cambio de reglas, prompt o modelo: `npm run test:riesgo` y `npm run riesgo:evaluar`. Los casos críticos pasan al 100 %.
- Una migración aplicada no se edita: se crea otra.
- Textos de conversación y datos de salud siempre cifrados (`Cifrador`). Accesos a transcripciones y planes, siempre en `registro_auditoria`.
- Nada clínico se improvisa: `TODO(clinico)` y valor conservador.
- Decisiones en `docs/decisiones/`.

---

# Vincular-IA — Contexto para iniciar el desarrollo

> **Cómo usar este documento:** pégalo completo al inicio de un chat nuevo (o guárdalo como `CLAUDE.md` en la raíz del repositorio). Contiene todo lo necesario para empezar a construir el producto mínimo del piloto. La especificación funcional completa está en el documento "Vínculo: plataforma psicosocial con IA para personas mayores".

---

## 0. Instrucciones para el asistente de desarrollo

Vas a ayudar a construir **Vincular-IA** (antes llamado "Vínculo"). Trabaja así:

1. **Antes de escribir código**, revisa la sección 11 ("Decisiones abiertas") y pregúntame las que bloqueen el primer sprint. No asumas en silencio.
2. **Empieza por el Sprint 1** (sección 10): estructura del repositorio, modelo de datos y el bucle conversacional por texto. La voz y el avatar vienen después.
3. **La seguridad no es un módulo opcional.** Cualquier código del bucle conversacional debe pasar por el guardián y el detector de riesgo desde el primer día, aunque sean versiones simples.
4. **Nada clínico se improvisa.** Si una regla necesita criterio clínico (umbrales, frases de riesgo, respuestas en crisis), deja un `TODO(clinico)` y un valor conservador; no inventes protocolos.
5. Escribe pruebas para todo lo que toque riesgo, escalamiento, memoria y permisos.
6. Idioma del producto: **español de Chile**. Idioma del código y los comentarios: inglés o español, pero consistente (proponer uno).

---

## 1. Qué es el producto

Plataforma psicosocial para **personas mayores que viven solas**, con tres capas:

1. **Acompañante conversacional** con voz (y avatar) que la propia persona diseña. Conversa libremente, recuerda lo conversado, toma la iniciativa y cumple cuatro roles: amigo, enfermero (medicación, citas), consejero (apoyo emocional con técnicas validadas) y puente (reconecta con familia, comunidad y profesionales).
2. **Supervisión clínica**: cada conversación genera un informe estructurado para un psicólogo supervisor, que define un **plan terapéutico vivo** que el agente lee antes de cada conversación.
3. **Grupos terapéuticos virtuales** con coordinador humano, donde la IA actúa como observador-cronista. *(Fase 2, fuera del MVP.)*

**Principio rector: puente, no reemplazo.** El éxito se mide en menos soledad y más contacto humano, no en minutos de uso. El tiempo de uso es una métrica de vigilancia: si sube mientras baja el contacto humano, es una alerta.

**Lo que NO es:** no diagnostica, no prescribe, no reemplaza a familia ni profesionales, nunca se hace pasar por humano, no puede configurarse como pareja romántica o sexual, no inventa una vida humana propia.

---

## 2. Alcance del MVP (piloto de 6 meses, 40–60 personas, una comuna)

### Incluido

| Módulo | Qué debe hacer en el MVP |
|---|---|
| Onboarding conversacional | 2–3 sesiones guiadas: biografía, gustos, salud funcional, red, rutina, línea base. Diseño del compañero (nombre, personalidad, forma de hablar, voz, avatar). |
| Conversación libre | Charla con continuidad, uso de memoria sin recitarla, tono adulto sin infantilizar. |
| Puente social | Sugerir llamar a familiares, recomendar actividades del catálogo comunitario, ayudar a redactar mensajes, celebrar contactos humanos. |
| Reminiscencia | Conversaciones guiadas por etapas de vida (el "libro de memorias" exportable puede quedar para después). |
| Enfermero digital | Recordatorios de medicación por voz con confirmación, segundo aviso a los 30 min, aviso al cuidador si no responde; citas; hoja de una página antes de cada control. **Nunca** sugiere cambiar, saltar ni duplicar dosis. |
| Detección temprana | Seguimiento de ánimo, sueño, apetito, aislamiento y adherencia; tamizaje conversacional (GDS-15) en momentos definidos. |
| Activación conductual | Metas pequeñas (caminar, sol, jardín, cocina) y seguimiento. |
| Anti-estafas | Detectar relatos de llamadas sospechosas y proponer verificar con un familiar. |
| Seguridad y escalamiento | Niveles 0–3 (sección 6). |
| Supervisión clínica | Resumen por sesión, informe semanal, informe de alerta, plan terapéutico editable. |
| Panel familiar | Resumen de bienestar (nunca transcripciones), alertas acordadas, proponer recordatorios. |
| Control de la memoria | "¿Qué recuerdas de mí?", corregir, olvidar, marcar temas como privados. |

### Fuera del MVP (no construir todavía)

- Grupos terapéuticos virtuales y sus análisis (fase 2).
- Módulo de música y estimulación cognitiva, apoyo en duelo estructurado (fase 2).
- Detección de caídas con sensores, reloj o botón (fase 2).
- Lentes teóricas psicoanalíticas en los informes (fase 2, requieren validación con analistas).
- **Diálogo con un ser querido fallecido: no construir.** Es una intervención clínica caso a caso que requiere un comité; queda fuera del producto general.
- Avatar realista animado: en el MVP basta un avatar ilustrado con animación simple (ver sección 4.5).
- Integración con la ficha clínica del CESFAM (pregunta abierta).

---

## 3. Usuarios y aplicaciones

| Aplicación | Usuario | Plataforma sugerida |
|---|---|---|
| **App del acompañante** | Persona mayor | Tablet Android preconfigurada en modo kiosco. Voz primero: la pantalla es apoyo. Un solo botón principal, letra grande, alto contraste, subtítulos. |
| **Panel clínico** | Psicólogo supervisor, gerontólogo, enfermera de enlace | Web. Bandeja de alertas, informes, plan terapéutico, auditoría del agente. |
| **Panel familiar** | Familiar o cuidador autorizado | Web responsive (o app ligera). Solo lo que la persona autoriza. |
| **Backoffice** | Equipo Vincular-IA | Web. Altas, dispositivos, catálogo comunitario, configuración de protocolos, turnos de guardia. |

**Regla de permisos central:** la persona mayor es la única dueña de la relación. Cada actor ve solo lo que ella autoriza, salvo riesgo vital (que la persona conoce desde el onboarding).

---

## 4. Arquitectura

### 4.1 Vista general

```
 Tablet (app acompañante)
   │  audio / texto (WebSocket)
   ▼
 Gateway de sesión ──► STT (voz a texto) ──► Orquestador ──► Guardián ──► TTS (texto a voz) ──► Tablet
                                               │   ▲
                         ┌─────────────────────┤   │ recuperación
                         ▼                     ▼   │
                 Detector de riesgo      Memoria (Postgres + pgvector)
                         │
                         ▼
                 Servicio de escalamiento ──► notificaciones a cuidador / supervisor / guardia
                                              (y guía para llamar a SAMU 131 o *4141)

 Planificador (jobs) ──► saludos, recordatorios, seguimientos, informes semanales
 Generador de informes ──► Panel clínico
```

### 4.2 Orquestador y especialistas

- **Un solo personaje hacia la persona.** Los "especialistas" (conversación y puente social, enfermero digital, apoyo emocional, detección temprana) se implementan como **herramientas e instrucciones dentro de un mismo bucle de agente**, no como chatbots distintos que se turnan. La persona nunca nota un cambio de voz ni de personalidad.
- Herramientas que el orquestador puede llamar (primer borrador):
  - `memory.search(query)`, `memory.upsert_fact(...)`, `memory.forget(...)`
  - `meds.get_schedule()`, `meds.confirm_dose(...)`
  - `appointments.list()`, `appointments.prepare_sheet(...)`
  - `community.find_activities(filters)`
  - `contacts.suggest_call(person)`, `contacts.draft_message(...)`
  - `screening.record_item(instrument, item, answer)`
  - `risk.report(level, evidence)` → dispara el flujo de escalamiento
- **Orden de precedencia de instrucciones** (fijarlo en el prompt y en el código): reglas de seguridad > plan terapéutico del supervisor > preferencias de la persona > personalidad del compañero.

### 4.3 Guardián

Capa que revisa **cada respuesta antes de emitirla**:
1. Reglas deterministas (rápidas): nada de dosis ni cambios de medicación, nada de diagnósticos, no afirmar ser humano, no prometer reencuentros, no contenido romántico, no venta ni publicidad, no frases que culpen por ausentarse.
2. Un modelo clasificador más pequeño para tono, salud y riesgo.
3. Si la respuesta falla: se regenera con la indicación del problema; si vuelve a fallar, se usa una respuesta segura predefinida.

Registrar toda intervención del guardián para auditoría clínica.

### 4.4 Detector de riesgo

- Corre sobre **cada turno de la persona**, en paralelo a la respuesta, no después.
- Combina reglas (frases explícitas y **frases indirectas** típicas de personas mayores: "ya no sirvo para nada", "estoy de más", "soy una carga", "quiero reunirme con él") con un clasificador de modelo de lenguaje.
- Ante la duda, **sube** el nivel, no lo baja. Los falsos positivos se calibran en el piloto; los falsos negativos no se aceptan.
- Los umbrales personalizados del plan terapéutico (por ejemplo "avisar si menciona reunirse con él") se suman a las reglas generales.

### 4.5 Voz y avatar

- **Voz primero.** Flujo en streaming: STT → orquestador → guardián → TTS. Meta de latencia percibida: idealmente bajo 2 segundos entre el fin del habla y el inicio de la respuesta (a medir y ajustar).
- STT robusto a habla lenta, pausas largas, acento chileno y prótesis dentales. **Hacer un benchmark de proveedores** con grabaciones reales del co-diseño antes de elegir.
- TTS con 3 voces a elegir en el onboarding, velocidad ajustable, tono grave disponible.
- Avatar del MVP: ilustración 2D con animación de boca simple sincronizada con el audio y pocas expresiones. Consistente en el tiempo. El avatar realista es una pregunta abierta (efecto "valle inquietante") para probar en el piloto.
- **Modo sin conexión** mínimo: los recordatorios de medicación deben sonar aunque se caiga internet (programados localmente en la tablet y sincronizados al reconectar).

### 4.6 Memoria

| Capa | Almacenamiento | Retención |
|---|---|---|
| Biográfica | Tabla estructurada | Permanente, editable |
| Relacional (personas, fechas) | Tabla estructurada | Permanente, editable |
| Episódica (lo conversado) | Resúmenes por sesión + embeddings (pgvector) | Resumida a los 30 días; detalle hasta 6 meses |
| Salud (medicación, citas, síntomas) | Tablas estructuradas | Mientras esté vigente |
| Preferencias | Tabla estructurada | Permanente, editable |
| Señales (tendencias) | Series de tiempo | 12 meses, solo para alertas |

- Extracción de hechos después de cada sesión, con **confirmación implícita**: el agente retoma el dato en la conversación siguiente y la persona puede corregirlo.
- Cada hecho guarda su origen (sesión y fragmento) para poder auditarlo.
- Los temas marcados como privados nunca aparecen en el panel familiar ni en informes que no sean del supervisor.
- La repetición de historias se registra como señal, no como error; el agente no corrige con frialdad.

### 4.7 Proactividad

Planificador de tareas (jobs) que:
- Inicia el saludo matinal en la hora que la persona eligió.
- Lanza los recordatorios de medicación y los segundos avisos.
- Retoma temas pendientes ("¿cómo le fue con la rodilla?").
- Genera los informes semanales.
- **Respeta horarios de descanso** y nunca insiste más allá de lo acordado.

---

## 5. Stack técnico sugerido (a confirmar)

| Pieza | Propuesta | Por qué |
|---|---|---|
| Lenguaje | TypeScript en todo el monorepo | Un solo lenguaje para app, paneles y backend |
| App del acompañante | React Native (Expo), modo kiosco Android | Tablet preconfigurada, actualizaciones controladas |
| Paneles | Next.js | Paneles web con autenticación y roles |
| Backend | Node.js con Fastify o NestJS | API, WebSocket de sesión, herramientas del agente |
| Base de datos | PostgreSQL + pgvector | Datos estructurados y búsqueda semántica en un solo lugar |
| Colas y jobs | Redis + BullMQ | Planificador, recordatorios, informes |
| Modelo de lenguaje | API de un proveedor de primer nivel detrás de un adaptador propio | Poder cambiar de proveedor y usar modelos distintos por tarea |
| Notificaciones | Push + SMS + llamada automática para niveles 2 y 3 | Las alertas no pueden depender de que alguien abra una app |
| Infraestructura | Contenedores en una nube con certificaciones de seguridad para salud | Requisito de datos sensibles |

**Uso de modelos por tarea (sugerencia):** un modelo de alta calidad para la conversación y los informes clínicos; un modelo rápido y económico para el guardián, el clasificador de riesgo y la extracción de memoria. Con Claude, por ejemplo: `claude-sonnet-5-5` para conversación, `claude-haiku-5-5` para guardián y clasificación, y `claude-opus-5-5` para informes semanales si la calidad lo justifica. Medir costo por persona al mes desde el Sprint 2.

**Requisito con el proveedor de modelos:** acuerdo de no uso de los datos para entrenamiento y la menor retención posible. Las conversaciones no se usan para entrenar modelos propios sin consentimiento específico.

---

## 6. Protocolo de seguridad y escalamiento (implementación)

| Nivel | Señales | Respuesta del agente | Quién interviene | Tiempo |
|---|---|---|---|---|
| 0 Rutina | Ánimo estable, adherencia normal | Conversación habitual | Nadie | — |
| 1 Atención | ≥2 días de ánimo bajo, peor sueño, menos apetito, aislamiento creciente, dosis olvidadas | Más contacto, activación conductual, sugerir llamar a alguien | Resumen semanal al cuidador (si autorizó) | 24–72 h |
| 2 Alerta | GDS elevado, desorientación nueva o súbita (posible delirium), caída sin lesión aparente, estafa en curso, rechazo persistente de medicación | Explica con honestidad que avisará; ofrece llamar juntos | Cuidador + supervisor clínico | < 4 h |
| 3 Emergencia | Ideación o plan suicida, dolor torácico, signos de ACV, caída con lesión, sin respuesta tras evento de riesgo | Se queda en la conversación, da instrucciones simples, conecta en línea | SAMU 131, línea *4141, cuidador y supervisor en paralelo | Inmediato |

**Requisitos de implementación:**
- Las alertas de nivel 2 y 3 requieren **acuse de recibo humano**. Si nadie confirma en X minutos, escalan al siguiente contacto y a la guardia. (`TODO(clinico)`: definir X y la cadena de contactos.)
- Nivel 3: el agente **no termina la conversación** y no deja sola a la persona mientras se activa la ayuda.
- El agente dice lo que va a hacer antes de hacerlo.
- Números de emergencia **en configuración**, no en el prompt, y verificados antes del lanzamiento (Fono Mayor de SENAMA: confirmar número vigente).
- Todo evento de nivel 2 y 3 queda registrado con fragmento literal, nivel, acción y tiempos, y lo revisa un profesional.
- **Pregunta abierta crítica:** qué institución cubre la guardia clínica 24/7.

**Conjunto de pruebas de riesgo (obligatorio desde el Sprint 1):** un archivo de casos con frases explícitas, indirectas, ambiguas y benignas, con el nivel esperado. Se corre en cada cambio de prompt o modelo. El equipo clínico lo amplía.

---

## 7. Informes clínicos (contra alucinaciones)

### Resumen de sesión (JSON validado con esquema)

1. Datos: fecha, hora, duración, quién inició.
2. Temas tratados, en orden y con tiempo dedicado.
3. Estado afectivo observado, con frases textuales.
4. Pensamientos y creencias relevantes.
5. Funcionamiento cotidiano: sueño, alimentación, actividad, salidas.
6. Red social: contactos mencionados, conflictos, sugerencias aceptadas o rechazadas.
7. Salud: adherencia, síntomas, citas.
8. Señales de riesgo: nivel (0–3) y justificación.
9. Intervenciones aplicadas y respuesta.
10. Observaciones para el supervisor y temas pendientes; hipótesis marcadas como tentativas.

**Reglas técnicas anti-alucinación:**
- Cada campo separa `observado` (lo que la persona dijo o hizo) de `inferido` (interpretación del agente).
- **Toda cita textual se verifica por código**: debe existir como fragmento en la transcripción de esa sesión. Si no existe, el informe se rechaza y se regenera.
- Ningún campo puede contener diagnósticos; el validador lo bloquea.
- La transcripción completa solo se abre por un motivo clínico registrado (queda en el log de accesos).

### Plan terapéutico vivo

Ficha que edita el supervisor y que el agente lee antes de cada conversación: formulación del caso, hipótesis clínica, objetivos, técnicas indicadas, técnicas o temas a evitar, temas a explorar, umbrales de alerta personalizados, próxima revisión. Cada cambio guarda autor, fecha y motivo. El agente **nunca** menciona el diagnóstico a la persona.

---

## 8. Modelo de datos (primer borrador)

```
person               (id, nombre, fecha_nac, comuna, estado, consentimiento_vigente_hasta, representante_legal_id?)
companion_profile    (person_id, nombre, personalidad, trato_usted_tu, voz_id, avatar_id, rol_preferente)
contact              (id, person_id, nombre, relacion, telefono, es_cuidador, permisos_json)
consent              (id, person_id, tipo, version, otorgado_en, revocado_en, otorgado_por)
session              (id, person_id, inicio, fin, iniciada_por, canal)
turn                 (id, session_id, hablante, texto, audio_ref?, creado_en)
memory_fact          (id, person_id, capa, contenido, privado, origen_turn_id, vigente, actualizado_en)
memory_embedding     (id, person_id, session_id, resumen, embedding vector)
medication           (id, person_id, nombre, proposito_simple, dosis_texto, horarios, vigente)
dose_event           (id, medication_id, programada_en, confirmada_en?, estado)
appointment          (id, person_id, lugar, profesional, fecha, hoja_preparada_ref?)
signal               (id, person_id, tipo, valor, medido_en)
screening_result     (id, person_id, instrumento, puntaje, items_json, aplicado_en, aplicado_por)
risk_event           (id, person_id, session_id, nivel, evidencia_turn_ids, accion, creado_en, acusado_por?, acusado_en?)
session_report       (id, session_id, contenido_json, estado_validacion)
weekly_report        (id, person_id, semana, contenido_json)
care_plan            (id, person_id, version, contenido_json, autor_id, motivo, creado_en)
community_activity   (id, comuna, nombre, descripcion, horario, contacto)
audit_log            (id, actor_id, accion, recurso, motivo, creado_en)
staff_user           (id, rol, nombre, institucion)
```

Todos los textos de conversación y datos de salud cifrados en reposo. Accesos a transcripciones y planes, siempre en `audit_log`.

---

## 9. Privacidad y cumplimiento

- **Ley 21.719** de protección de datos personales: entra en vigencia el 1 de diciembre de 2026 (hay un proyecto en trámite que podría postergarla). Los datos de salud y emocionales son **datos sensibles**: consentimiento explícito e informado, finalidad clara, minimización, derechos de acceso, rectificación, supresión y portabilidad, medidas de seguridad y registro de actividades de tratamiento. Revisar con abogado las transferencias internacionales (servidores y proveedor de modelos fuera de Chile).
- **Ley 20.584** de derechos y deberes de los pacientes (confidencialidad de la información clínica).
- **Convención Interamericana sobre la Protección de los Derechos Humanos de las Personas Mayores.**
- **ISP:** el producto no debe hacer afirmaciones de diagnóstico o tratamiento para no clasificar como dispositivo médico; validar con asesoría.
- Consentimiento revisado cada 6 meses y ante cambios cognitivos; si la capacidad disminuye, interviene el representante legal o familiar designado.
- Funciones obligatorias desde el MVP: exportar y borrar toda la memoria de una persona; panel familiar sin transcripciones; cifrado en tránsito y en reposo; control de acceso por rol; log de auditoría.
- **Diseño sin adicción:** nada de rachas, premios por uso ni frases que culpen por ausentarse ("te extrañé tanto"). Sin venta ni publicidad en la conversación.

---

## 10. Plan de sprints sugerido (2 semanas cada uno)

| Sprint | Objetivo | Entregable demostrable |
|---|---|---|
| 1 | Base técnica | Monorepo, modelo de datos, autenticación y roles, bucle conversacional **por texto** con orquestador, guardián básico, detector de riesgo por reglas y su conjunto de pruebas |
| 2 | Memoria y personaje | Perfil del compañero, memoria estructurada y episódica, "¿qué recuerdas de mí?", corregir y olvidar; medición de costo por conversación |
| 3 | Voz | STT y TTS en streaming en la tablet, benchmark de proveedores, latencia medida |
| 4 | Enfermero digital | Medicación con confirmación, segundo aviso, aviso al cuidador, citas, hoja de consulta, recordatorios sin conexión |
| 5 | Escalamiento | Niveles 0–3 de punta a punta, acuse de recibo, cadena de contactos, notificaciones push, SMS y llamada |
| 6 | Supervisión clínica | Resumen de sesión con validación de citas, informe semanal, plan terapéutico editable, bandeja de alertas |
| 7 | Onboarding y panel familiar | Onboarding conversacional completo, línea base, panel familiar con permisos |
| 8 | Proactividad y puente social | Planificador, saludo matinal, temas pendientes, catálogo comunitario, sugerencias de contacto, anti-estafas |
| 9 | Endurecimiento | Pruebas con personas mayores del co-diseño, accesibilidad, modo kiosco, auditoría de seguridad, revisión legal |

El co-diseño con personas mayores (3 meses) debe correr **en paralelo** desde el Sprint 2, con prototipos reales.

---

## 11. Decisiones abiertas (preguntar antes de asumir)

1. ¿Quién financia el piloto y el servicio: persona, familia, municipio, isapre o FONASA, caja de compensación, modelo mixto?
2. ¿Qué institución cubre la supervisión clínica humana 24/7 de los niveles 2 y 3?
3. ¿Qué dispositivo se entrega: tablet, parlante con pantalla o teléfono? ¿Se evalúa llamada a teléfono fijo?
4. ¿Avatar ilustrado o realista? (MVP: ilustrado.)
5. ¿Qué proveedor de modelo de lenguaje, STT y TTS? (Requiere benchmark y acuerdo de datos.)
6. ¿Dónde se alojan los datos y cómo se cumplen las transferencias internacionales?
7. ¿Cómo se integra con la ficha clínica del CESFAM sin duplicar registros? (MVP: sin integración; informes exportables.)
8. ¿Qué comuna, CESFAM y universidad son socios del piloto?
9. ¿Quién arma el equipo de desarrollo y con qué presupuesto y plazos?

---

## 12. Criterios de aceptación transversales

- Ninguna respuesta del agente sale sin pasar por el guardián.
- El conjunto de pruebas de riesgo pasa al 100 % en los casos explícitos y en los indirectos marcados como críticos antes de cada despliegue.
- Toda cita textual en un informe existe en la transcripción.
- Una persona puede ver, corregir, exportar y borrar su memoria.
- El panel familiar nunca muestra transcripciones ni temas privados.
- Los recordatorios de medicación funcionan sin conexión.
- Una persona de 80 años con baja alfabetización digital puede usar la app sola desde el primer día (se prueba con usuarios reales, no se asume).