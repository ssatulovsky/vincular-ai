# 0001 · Sprint 1: base técnica

Fecha: 12-11-2026 · Estado: aceptada

## Decisiones confirmadas con el equipo

| Tema | Decisión |
|---|---|
| Backend | Node.js 22 + TypeScript + Fastify 5 |
| Idioma del código | Español (código, comentarios, tablas). Producto en español de Chile. |
| Modelo de lenguaje | Gemini por defecto, Claude intercambiable **por configuración y por tarea**. Sin modelos simulados. |
| Repositorio | `ssatulovsky/vincular-ai`, monorepo con npm workspaces |

## Decisiones técnicas tomadas en el sprint

1. **Monorepo con tres piezas**:
   - `paquetes/seguridad-clinica`: detector de riesgo y guardián por reglas, respuestas seguras y conjuntos de casos. Sin dependencias, para poder correrlo también en la tablet (modo sin conexión).
   - `paquetes/ia`: adaptador propio de modelos (Gemini y Claude), un modelo por tarea.
   - `apps/servidor`: API, canal WebSocket, orquestador, base de datos.
   Las apps de la tablet (Expo) y los paneles (Next.js) se agregan como `apps/*` cuando llegue su sprint.

2. **Sin paso de compilación en desarrollo**: TypeScript se ejecuta con `tsx` y los paquetes exportan sus `.ts`. La compilación para producción se resuelve en el Sprint 9 junto con los contenedores.

3. **Los nombres de modelo no se fijan en el código**: cada tarea (`conversacion`, `guardian`, `riesgo`, `extraccion`, `informes`) lee `IA_PROVEEDOR_<TAREA>` e `IA_MODELO_<TAREA>`. `npm run ia:modelos` lista los modelos que la clave puede usar. En producción el servidor no arranca sin modelo de conversación, guardián y riesgo.

4. **Precedencia de instrucciones aplicada en dos lugares**: en el texto de las instrucciones (secciones 1 a 4) y en el código (el guardián revisa la salida contra las reglas y los términos prohibidos del plan; el perfil del compañero se valida al guardarse y no puede ser romántico, humano ni imitar a un cónyuge).

5. **El agente nunca ve la formulación ni la hipótesis clínica del plan**. Solo objetivos, técnicas, temas a evitar y explorar, e indicaciones. Así no puede mencionarlas ni por error. Los términos de `no_mencionar` los bloquea el guardián.

6. **Detector de riesgo en dos capas**:
   - Reglas síncronas antes de generar: si dan nivel 3, la respuesta es el **texto del protocolo** al instante, sin esperar al modelo.
   - Clasificador con modelo en paralelo a la generación, con plazo (`RIESGO_ESPERA_CLASIFICADOR_MS`). Solo sube el nivel. Si sube a 3, se descarta lo generado y sale el protocolo; si sube a 2, se regenera con las indicaciones de alerta.
   - El agente también puede reportar riesgo con la herramienta `riesgo_reportar` (solo sube).

7. **Guardián que falla cerrado**: reglas deterministas → clasificador con modelo → un reintento → respuesta segura. Si el clasificador no responde, no se aprueba la respuesta. En nivel 2 la respuesta debe decir que avisará (regla `nivel2.sin_aviso`).

8. **Números de emergencia fuera del prompt** (`config/protocolo-emergencia.json`). El código los agrega a las respuestas de crisis y, mientras dura el modo emergencia, al final de cada respuesta. En producción no arranca con números sin verificar.

9. **Modo emergencia persistente**: la sesión no se puede cerrar desde la tablet; una sesión nueva parte en emergencia si hay un evento de nivel 3 sin acuse humano en las últimas 24 horas.

10. **Cifrado en la aplicación** (AES-256-GCM) de todo texto de conversación, nombres, teléfonos, datos de salud, planes y fragmentos de riesgo. Los vectores de pgvector no se pueden cifrar: el Sprint 2 debe evaluar que no permitan reconstruir el texto.

11. **Inmutabilidad en la base**: la aplicación (rol `vincular_app`) solo inserta y lee turnos, planes, intervenciones del guardián, señales, uso de modelos y eventos de riesgo; del evento solo puede registrar el acuse, una vez. La auditoría no se modifica ni por el dueño de la tabla.

12. **Permisos en una función pura** (`decidirPermiso`) con pruebas de matriz. El administrador de plataforma gestiona altas pero no ve contenido clínico. La guardia ve alertas de todas las personas pero no planes ni transcripciones. Solo el supervisor asignado abre transcripciones, con motivo registrado.

13. **Pruebas sin simulaciones**: contra PostgreSQL real. Los caminos que no deben depender del modelo (reglas, protocolo, respuestas seguras, registros) se prueban con el proveedor apuntando a un puerto cerrado, una falla de red real. La calidad del modelo se prueba con `npm run riesgo:evaluar` y `VINCULAR_PRUEBA_IA_REAL=1 npm test`.

## Pendientes conocidos (no son deuda oculta)

- **Notificaciones (Sprint 5)**: hoy los niveles 2 y 3 quedan en la bandeja de alertas, pero no se envía push, SMS ni llamada. El agente dice "voy a avisar": **no usar con personas reales antes del Sprint 5**.
- **Segundo factor para el personal clínico** (Sprint 6).
- **Seguridad por fila (RLS)** en PostgreSQL además de los permisos en la aplicación (Sprint 9).
- **Gestión de claves** con un servicio de la nube en vez de variable de entorno (Sprint 9).
- **Búsqueda semántica** de memoria y dimensión del vector (Sprint 2).

## TODO(clinico) abiertos

Ver `grep -rn "TODO(clinico)"`. Los principales: catálogo de reglas y niveles del detector, textos de crisis, ventana de 24 h del modo emergencia, plazo de acuse y cadena de contactos, protocolo de maltrato, prompt del clasificador de riesgo.
