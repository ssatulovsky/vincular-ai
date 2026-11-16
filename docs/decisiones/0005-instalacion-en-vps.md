# 0005 · Instalación en un VPS Ubuntu propio

Fecha: 16-11-2026 · Estado: aceptada

## Contexto

El equipo prueba el sistema en un VPS Ubuntu propio y no quiere contratar hosting ni suscripciones mientras no haya ventas. El responsable del tratamiento de datos es InnovAgile Group SpA.

## Decisiones

1. **Un instalador idempotente** (`scripts/vps/instalar.sh`) para Ubuntu 22.04 y 24.04: PostgreSQL 16 + pgvector desde el repositorio oficial de PostgreSQL, Node.js 22, usuario de sistema `vincular`, código en `/opt/vincular-ai`, servicio systemd y Caddy con HTTPS automático. Se puede volver a correr sin cambiar contraseñas ni el `.env`.
2. **Las claves no pasan por ningún chat ni por el repositorio**: el instalador genera las contraseñas de la base y `CLAVE_CIFRADO`, y deja el `.env` con permiso 600 para el usuario `vincular`. Las claves de API las escribe la persona en el VPS.
3. **Llave de despliegue de solo lectura** para que el VPS baje el código privado; el VPS no puede escribir en el repositorio.
4. **El servidor escucha solo en 127.0.0.1**; Caddy publica HTTPS (necesario para el micrófono del navegador). Sin dominio propio se usa `<ip>.sslip.io`. Si los puertos 80/443 ya están ocupados, el instalador no toca ese servidor web y avisa.
5. **El firewall no se activa por el instalador** (podría cortar el SSH si usa otro puerto); si ufw ya está activo, solo abre 80 y 443.
6. **`NODE_ENV=development`** en el VPS de pruebas: en producción el servidor exige números de emergencia verificados.
7. **Alta de prueba por CLI** (`npm run cli:alta-prueba`, `scripts/vps/alta-prueba.sh`): crea una persona y su tablet en una transacción, con auditoría, y muestra el código una sola vez (en la base queda solo el hash).

## Límites conocidos

- Sin respaldos automáticos ni alta disponibilidad.
- No apto para datos de personas reales sin supervisión: las notificaciones (Sprint 5) aún no se envían y falta la revisión legal.
