# Vincular-IA

Acompañante conversacional con supervisión clínica para personas mayores que viven solas. **Puente, no reemplazo**: el éxito se mide en menos soledad y más contacto humano, no en minutos de uso.

> **Estado: Sprint 1 (base técnica).** Bucle conversacional por texto con orquestador, guardián y detector de riesgo; modelo de datos; autenticación y roles. Sin voz, sin tablet y **sin notificaciones** todavía: no usar con personas reales antes del Sprint 5. Ver `docs/decisiones/0001-sprint-1-base-tecnica.md`.

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
