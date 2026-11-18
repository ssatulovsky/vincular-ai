# Instalar Vincular-IA en un VPS Ubuntu

Guía para dejar el servidor funcionando en un VPS Ubuntu 22.04 o 24.04, sin servicios pagos de hosting. Sirve para desarrollo y co-diseño **acompañado**: no usar con personas reales sin supervisión ni con datos clínicos reales (ver "Límites" al final).

Tiempo estimado: 20 minutos.

## Lo que necesita

- Acceso por SSH al VPS con un usuario que pueda usar `sudo`.
- Su cuenta de GitHub con acceso a este repositorio.
- Las claves de API (no se pegan en ningún chat; van solo en el archivo `.env` del VPS).

## 1. Bajar el instalador al VPS

El repositorio es privado, así que el instalador se baja con un enlace temporal:

1. En GitHub abra `scripts/vps/instalar.sh` y pinche **Raw**.
2. Copie la dirección de esa página (incluye `?token=...`; vence en unos minutos).
3. En el VPS:

```bash
curl -fsSL 'PEGUE-AQUÍ-LA-DIRECCIÓN' -o instalar.sh
```

## 2. Ejecutarlo

```bash
sudo bash instalar.sh
```

Si tiene un subdominio propio apuntando al VPS (registro A con la IP del VPS), páselo como argumento: `sudo bash instalar.sh vincular.ejemplo.cl`. Sin argumento, la dirección será `<ip-con-guiones>.sslip.io`, que funciona sin comprar dominio.

A mitad de camino el instalador muestra una **llave de despliegue** y se detiene:

1. Copie la línea que empieza con `ssh-ed25519`.
2. En GitHub: repositorio → **Settings** → **Deploy keys** → **Add deploy key**.
3. Title: `vps`. Key: la línea copiada. **No** marque "Allow write access".
4. Vuelva al VPS y presione Enter.

## 3. Poner sus claves

```bash
sudo -u vincular nano /opt/vincular-ai/.env
```

Complete, según el proveedor que use:

| Variable | Qué poner |
|---|---|
| `IA_PROVEEDOR` | `gemini` o `anthropic` |
| `GEMINI_API_KEY` o `ANTHROPIC_API_KEY` | Su clave |
| `IA_MODELO_CONVERSACION`, `IA_MODELO_GUARDIAN`, `IA_MODELO_RIESGO`, `IA_MODELO_EXTRACCION` | Los modelos. Con Claude, el archivo trae un ejemplo comentado. Para ver los modelos disponibles con su clave: `cd /opt/vincular-ai && sudo -u vincular bash -c 'set -a; . ./.env; set +a; npm run ia:modelos'` |
| `IA_MODELO_IMAGENES` | Opcional: modelo de Gemini para los retratos del compañero (p. ej. `gemini-3.1-flash-lite-image`). Usa la misma `GEMINI_API_KEY` |
| `ELEVENLABS_API_KEY` y `VOZ_STT_PROVEEDOR=elevenlabs` | Opcional: reconocimiento de voz con ElevenLabs (plan gratuito para pruebas) |
| `VOZ_GOOGLE_CLAVE_API` | Opcional: las voces del catálogo (Google Chirp 3 HD). Es una clave de Google Cloud con la API Text-to-Speech activada, distinta de la clave de Gemini |

Sin claves de voz, la tablet funciona igual con el botón **Escribir** y las respuestas en pantalla.

Guarde con **Ctrl+O**, Enter, y salga con **Ctrl+X**. No toque `DATABASE_URL` ni `CLAVE_CIFRADO`: los generó el instalador. **Si se pierde `CLAVE_CIFRADO`, los datos cifrados no se pueden recuperar**: guarde una copia del `.env` en un gestor de contraseñas.

## 4. Encender y probar

```bash
sudo systemctl restart vincular
sudo journalctl -u vincular -n 50 --no-pager      # debe decir "Server listening"
sudo bash /opt/vincular-ai/scripts/vps/alta-prueba.sh
```

El último comando pide un nombre y una comuna de prueba y muestra un **código**. En la tablet, abra `https://<su-dirección>/tablet` y pegue ese código.

Para diseñar el compañero (género, edad, nombre, voz y retrato): en la tablet, el enlace **Mi compañero**; desde un computador, `https://<su-dirección>/companero` con una cuenta del equipo.

**Panel del equipo:** `https://<su-dirección>/panel`. La primera cuenta de administración se crea en el VPS:

```bash
sudo bash /opt/vincular-ai/scripts/vps/crear-admin.sh
```

Con esa cuenta, en el panel: **Equipo → Crear cuenta** para cada profesional (psicólogo supervisor, enfermera de enlace, gerontólogo, guardia) y **Pacientes → Agregar persona** para cada participante. En la ficha de la persona: contactos, código de la tablet, equipo asignado y consentimiento. Cada profesional ve solo a las personas que se le asignan; la administración nunca ve contenido clínico.

## 5. Conversación en tiempo real (opcional)

Por defecto la tablet conversa por turnos: escucha, envía lo que oyó y responde. Con tiempo real la conversación es una llamada de voz continua: el compañero detecta cuándo terminó de hablar (respetando pausas largas), responde con su voz y se calla si la persona lo interrumpe. Usa LiveKit, un servidor de audio libre que corre en el mismo VPS, sin suscripción. La voz de ElevenLabs se cobra igual que en el modo por turnos.

```bash
sudo bash /opt/vincular-ai/scripts/vps/tiempo-real.sh
```

El script instala LiveKit, publica `https://livekit.<su-dirección>` con su certificado, escribe las claves en el `.env` (no hay que copiar nada) y deja dos servicios nuevos: `livekit` y `vincular-agente`.

**Además**, en el firewall del panel web de su proveedor abra **TCP 7881** y **UDP 50000-60000**: por ahí pasa el audio.

En la tablet, recargue `/tablet` y toque «Conversemos». Si el tiempo real no está disponible o la conexión falla, la tablet vuelve sola al modo por turnos.

## Actualizar a la última versión

```bash
sudo bash /opt/vincular-ai/scripts/vps/actualizar.sh
```

## Si algo falla

| Síntoma | Qué revisar |
|---|---|
| `journalctl` muestra "Configuración inválida" | Una variable del `.env` mal escrita; el mensaje dice cuál |
| La tablet no abre la página | Que los puertos 80 y 443 estén abiertos en el panel del proveedor del VPS |
| El micrófono no funciona | La dirección debe empezar con `https://` |
| «Conversemos» se queda en «Conectando…» | `sudo journalctl -u vincular-agente -n 50 --no-pager`; que TCP 7881 y UDP 50000-60000 estén abiertos en el panel del proveedor |
| El compañero no escucha en tiempo real | La clave de ElevenLabs y su plan (`journalctl -u vincular-agente` muestra el error de ElevenLabs) |
| sslip.io no obtiene certificado | Límite de Let's Encrypt para ese dominio compartido: use un subdominio propio |

## Límites de este entorno

- Un solo servidor sin respaldos automáticos: configure copias de la base (`pg_dump`) si guarda algo que importe.
- `NODE_ENV=development`: en producción el servidor exige números de emergencia verificados y modelos obligatorios.
- Las notificaciones de alerta todavía no se envían (Sprint 5): **ninguna persona usa el sistema sin un profesional presente**.
- Antes de datos reales: revisión legal (Ley 21.719, transferencias internacionales a los proveedores de modelos y voz) y acuerdos de tratamiento de datos con cada proveedor.
