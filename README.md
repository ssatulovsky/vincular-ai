# Vincular-IA

Acompañante conversacional con supervisión clínica para personas mayores que viven solas. **Puente, no reemplazo**: el éxito se mide en menos soledad y más contacto humano, no en minutos de uso.

> **Estado: Sprint 5 (escalamiento).** Niveles 0–3 de punta a punta: protocolos parametrizables por tipo, nivel, categoría, persona y horario; turnos de guardia; SMS y llamadas por Twilio; acuse por panel, SMS ("1") o llamada (tecla 1); la cadena avanza sola si nadie acusa o si los mensajes fallan. En nivel 3 el sistema guía a la persona y avisa a la guardia (no llama al SAMU).
>
> **Sprint 4 (enfermero digital).** Medicamentos registrados por el equipo de salud, recordatorios por voz con segundo aviso a los 30 min y aviso al cuidador autorizado (o al equipo) si no hay respuesta, confirmación por voz, pantalla o sin conexión, citas, preguntas para el control y hoja de una página. Las notificaciones se crean; su envío llega en el Sprint 5.
>
> **Sprint 3 (voz).** Turno hablado de punta a punta (voz a texto → orquestador con riesgo y guardián → texto a voz por frases) con Google y ElevenLabs intercambiables, latencia medida por etapa, prototipo web de la tablet en `/tablet`, prueba ciega de voces para el co-diseño y benchmark de reconocimiento con métrica de riesgos perdidos.
>
> **Sprint 2 (memoria y personaje).** Sobre la base del Sprint 1 (bucle por texto con orquestador, guardián y detector de riesgo; autenticación y roles): memoria estructurada y episódica con extracción verificada por citas, "¿qué recuerdas de mí?", corregir, olvidar, privado, exportar y borrar; perfil del compañero que diseña la persona; costo por conversación y por persona al mes. Sin voz, sin tablet y **sin notificaciones** todavía: no usar con personas reales antes del Sprint 5. Ver `docs/decisiones/`.

## Estructura

```
paquetes/
  seguridad-clinica/   Detector de riesgo y guardián por reglas, respuestas seguras
    casos/             Conjuntos de casos de riesgo y del guardián (los amplía el equipo clínico)
  ia/                  Adaptador de modelos: Gemini y Claude, configurable por tarea
apps/
  servidor/            API (Fastify), canal WebSocket, orquestador, base de datos
    db/bootstrap.sql   Roles y extensión pgvector (una vez, con superusuario)
    db/migraciones/    SQL versionado; una migración aplicada no se edita
config/
  protocolo-emergencia.json   Números de emergencia (nunca en el prompt)
CLAUDE.md                     Convenciones y especificación del MVP
docs/decisiones/              Registro de decisiones
```

## Puesta en marcha

Requisitos: Node.js 22 y PostgreSQL 16 con pgvector (o Docker).

```bash
npm ci
docker compose up -d postgres
docker compose exec postgres psql -U postgres -v owner_pass=owner_local -v app_pass=app_local -v db=vincular -f /bootstrap.sql

cp .env.example .env          # complete CLAVE_CIFRADO (openssl rand -hex 32), las claves de API y los modelos
set -a; . ./.env; set +a
npm run ia:modelos            # lista los modelos disponibles para elegir IA_MODELO_<TAREA>
npm run db:migrar
CONTRASENA_NUEVA='...' npm run cli:crear-cuenta -w @vincular/servidor -- --email admin@ejemplo.cl --nombre "Admin"
npm run dev
```

### Precios de los modelos

`config/precios-modelos.json` guarda el precio por millón de tokens de cada `proveedor/modelo`. Complételo con los precios vigentes de su contrato; sin precio, el reporte muestra tokens y deja el costo en `null`.

### Cambiar de proveedor de modelo

Todo es configuración. Gemini en todo:

```
IA_PROVEEDOR=gemini
IA_MODELO_CONVERSACION=<modelo de alta calidad>
IA_MODELO_GUARDIAN=<modelo rápido>
IA_MODELO_RIESGO=<modelo rápido>
```

Claude en todo: `IA_PROVEEDOR=anthropic` y los modelos de Claude. Mixto: `IA_PROVEEDOR_GUARDIAN=anthropic` cambia solo esa tarea.

## Pruebas

```bash
TEST_PG_ADMIN_URL=postgres://postgres:postgres_local@localhost:5432/postgres npm test
npm run test:riesgo                       # solo reglas: casos de riesgo y del guardián
npm run riesgo:evaluar                    # reglas + clasificador del modelo configurado
VINCULAR_PRUEBA_IA_REAL=1 npm test        # además, pruebas contra los proveedores reales
```

Cada ejecución crea una base de datos nueva, aplica las migraciones y la elimina. No hay modelos simulados: los caminos que no deben depender del modelo se prueban con el proveedor inalcanzable.

**Criterio de despliegue:** el conjunto de casos de riesgo pasa al 100 % en los casos explícitos e indirectos críticos.

## Flujo de un turno

1. La tablet envía el texto (`POST /api/conversacion/sesiones/:id/turnos` o WebSocket `/api/conversacion/ws`).
2. Se guarda el turno cifrado y corren las **reglas de riesgo** (incluidos los umbrales personales del plan).
3. Si dan **nivel 3**: respuesta del protocolo de emergencia al instante; la sesión queda en modo emergencia.
4. Si no: el modelo genera (con herramientas) mientras el **clasificador de riesgo** corre en paralelo. El nivel final es el mayor entre reglas, clasificador y lo que reporte el agente.
5. Toda respuesta del modelo pasa por el **guardián** (reglas + clasificador). Un reintento; si falla, respuesta segura.
6. Se registran señales (nivel 1+), eventos con acuse requerido (nivel 2 y 3), intervenciones del guardián y uso de modelos (costo).
7. Al cerrar la sesión (o tras `MEMORIA_MINUTOS_INACTIVIDAD` sin turnos, con `npm run memoria:procesar`) se extrae la memoria: hechos nuevos "por confirmar" con cita literal verificada, correcciones, resumen de la conversación con su embedding y temas pendientes.

## Voz

```bash
npm run voz:voces -- --acento chilean          # buscar voces chilenas en ElevenLabs
npm run voz:prueba-ciega                        # genera la página de escucha a ciegas
npm run voz:resultados -- --clave salida/…/clave.json resultados/*.csv
npm run voz:benchmark-stt -- --guion > grabaciones/manifiesto.csv
npm run voz:benchmark-stt -- grabaciones        # WER, latencia y riesgos perdidos
```

Prototipo de la tablet: abrir `https://<servidor>/tablet` en la tablet y pegar el código del dispositivo. El micrófono del navegador exige HTTPS (o `localhost`). Protocolo de grabaciones: `docs/voz/protocolo-grabaciones.md`.

## Tareas periódicas

El servidor corre un planificador propio (recordatorios cada 20 s, memoria cada 5 min). Con `PLANIFICADOR=no`, programar con cron:

```bash
npm run memoria:procesar          # cada 5 minutos (si PLANIFICADOR=no)
npm run medicacion:ciclo          # cada minuto (si PLANIFICADOR=no)
npm run costos:reporte -- 2026-11 # cuando se necesite
```

## API (Sprint 1)

| Método y ruta | Quién | Uso |
|---|---|---|
| `POST /api/auth/ingresar` · `POST /api/auth/salir` · `GET /api/yo` | todos | Sesión |
| `POST /api/cuentas` | admin | Cuentas de personal y de familiares |
| `POST /api/personas` · `…/contactos` · `…/dispositivos` · `…/asignaciones` | admin | Altas; el token de la tablet se entrega una vez |
| `PUT /api/personas/:id/perfil-companero` | admin, clínicos asignados | Perfil del compañero |
| `GET/PUT /api/personas/:id/plan-terapeutico` | clínicos asignados / supervisor | Plan versionado con autor y motivo |
| `GET /api/alertas` · `GET /api/alertas/:id` · `POST /api/alertas/:id/acuse` | clínicos asignados, guardia | Bandeja de niveles 2 y 3 |
| `GET /api/personas/:id/sesiones/:sid/transcripcion?motivo=` | supervisor asignado | Solo con motivo clínico, auditado |
| `POST /api/conversacion/sesiones` · `…/:id/turnos` · `…/:id/cerrar` · `WS /api/conversacion/ws` | tablet | Conversación |
| `GET /api/mi-memoria` · `PATCH/DELETE /api/mi-memoria/hechos/:id` · `GET /api/mi-memoria/exportar` · `DELETE /api/mi-memoria` | tablet | La persona ve, corrige, confirma, marca privado, olvida, exporta y borra su memoria |
| `GET/PUT /api/mi-perfil-companero` | tablet | La persona diseña su compañero |
| `GET /api/personas/:id/memoria` | clínicos asignados | Memoria de la persona (auditado) |
| `GET /api/costos?mes=AAAA-MM` · `GET /api/costos/sesiones/:id` | admin | Costo por persona al mes y por conversación |
| `GET/POST /api/personas/:id/medicamentos` · `PUT …/:medId` · `POST …/:medId/suspender` · `GET /api/personas/:id/dosis` | equipo asignado | Medicación y adherencia |
| `GET/POST /api/personas/:id/citas` · `POST …/:citaId/cancelar` · `GET …/:citaId/hoja` | equipo asignado (hoja: también familiar autorizado) | Citas y hoja para el control |
| `GET /api/mi-medicacion/hoy` · `GET /api/mi-medicacion/agenda` · `POST /api/mi-medicacion/confirmar` · `GET /api/mis-citas` · `GET /api/mis-citas/:id/hoja` | tablet | La persona y su medicación |
| `GET/POST /api/protocolos-escalamiento` · `PUT …/:id` | admin, supervisor | Protocolos (con motivo) |
| `GET/POST /api/guardia/turnos` · `PUT …/:id` | admin, supervisor | Turnos de guardia |
| `PUT /api/cuentas/:id/telefono` | admin | Teléfono del personal |
| `GET /api/escalamientos` · `GET …/:id` · `POST …/:id/acuse` | guardia, equipo asignado | Cadenas en curso y acuse |
| `POST /webhooks/twilio/sms` · `/llamada` · `/estado` | Twilio (firmado) | Respuestas y estados |
| `GET /api/voces` · `GET /api/voces/:id/muestra` | tablet | Voces ofrecidas y muestra en la velocidad y el trato de la persona |
| `WS /api/conversacion/ws` → `{"tipo":"audio",…}` | tablet | Turno hablado (ver `voz/turnoVoz.ts`) |
| `GET /tablet` | — | Prototipo web de la app del acompañante |
