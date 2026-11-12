# Protocolo de grabaciones para el benchmark de voz

Todavía no hay grabaciones. Este protocolo dice qué grabar, con quién y cómo, para comparar el reconocimiento de voz de Google (Chirp 3) y ElevenLabs (Scribe) con voces reales de personas mayores de la comuna del piloto.

> TODO(clinico): este protocolo debe revisarlo el equipo clínico y, si corresponde, el comité de ética de la universidad socia antes de grabar a cualquier persona.

## Qué medimos

1. **Tasa de error por palabra (WER)**: cuánto se equivoca el reconocedor.
2. **Latencia**: cuánto demora en devolver el texto (p50 y p90).
3. **Riesgos perdidos**: frases de riesgo que el detector deja de ver después del reconocimiento ("me duele el pecho" → "me duele el techo"). **Es la métrica que decide**: debe ser 0 en las frases críticas, aunque otro proveedor tenga mejor WER.

## Con quién

- **Frases cotidianas** (`config/voz/frases-grabacion.json`): personas mayores del co-diseño, con consentimiento informado específico para grabación y uso en pruebas técnicas.
- **Frases de riesgo** (de `paquetes/seguridad-clinica/casos/riesgo.casos.json`): **nunca** se le pide a una persona del piloto que lea "me quiero morir". Se graban con voluntarios adultos mayores sin indicadores de riesgo, o con profesionales del equipo, con aprobación clínica previa y explicando el propósito. TODO(clinico): definir quién y cómo.

Diversidad mínima recomendada: al menos 12 personas, hombres y mujeres, de 65 a 90+ años, incluyendo personas con prótesis dental, con habla lenta o con pausas largas, y con distintos niveles de escolaridad.

## Cómo grabar

- **Con la tablet del piloto** y su micrófono, a la distancia en que se usará (sobre la mesa, a 40–60 cm). No con micrófonos profesionales: queremos medir las condiciones reales.
- En el lugar real: la casa, con la tele o la radio de fondo en algunas grabaciones (anótelo en `condicion`).
- Formato: WAV 16 kHz mono si es posible; también sirven M4A, MP3, WebM u OGG.
- Una frase por archivo. Pida que la digan **con sus propias palabras** cuando se pueda (es más realista que leer) y transcriba a mano exactamente lo que dijo.
- No registre nombres en los archivos: use códigos (`P07-c03.wav`).

## Paso a paso

```bash
npm run voz:benchmark-stt -- --guion > grabaciones/manifiesto.csv   # plantilla con las frases
# grabar, nombrar los archivos como en la plantilla y corregir "referencia" con lo que se dijo
# completar "condicion": p. ej. "protesis", "tele de fondo", "habla lenta"
npm run voz:benchmark-stt -- grabaciones --proveedores google,elevenlabs
```

Resultado: `grabaciones/resultado-stt.md` (resumen por proveedor) y `grabaciones/resultado-stt.csv` (detalle por audio).

## Cuidado de los datos

Las grabaciones son datos sensibles (voz y, en algunas frases, salud). Se guardan cifradas, fuera del repositorio, con acceso solo del equipo técnico del benchmark, y se borran al terminar la evaluación (o según lo que diga el consentimiento). Al enviarlas a los proveedores para el benchmark aplican sus condiciones de datos: revisar antes de usar audios reales (sección 9 de la especificación).
