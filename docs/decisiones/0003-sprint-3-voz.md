# 0003 · Sprint 3: voz

Fecha: 12-11-2026 · Estado: aceptada (la elección final de proveedor queda para después de la prueba ciega y el benchmark)

## Proveedores en evaluación

Pedido: las voces de Google y un proveedor lo más natural posible, que permita probar antes de pagar.

| | Google | ElevenLabs |
|---|---|---|
| Texto a voz | Chirp 3 HD (streaming, `es-US`/`es-ES`) y Gemini-TTS (instrucción de estilo en lenguaje natural; `es-419` en vista previa; sin streaming) | `eleven_v4_turbo`, `eleven_flash_v2_5`, `eleven_v3_conversational` (baja latencia), con voces de la biblioteca |
| Acento chileno | **No hay voces es-CL.** Gemini-TTS puede intentarlo con una instrucción de acento | **Sí**: la biblioteca tiene voces chilenas de la comunidad |
| Voz a texto | Chirp 3 (`es-US`, `es-ES` GA; `es-MX` vista previa; sin `es-CL`) | Scribe (`scribe_v3` por turno; `scribe_v3_live` en tiempo real) |
| Probar sin pagar | Capa gratuita mensual de Chirp 3 HD (1 M de caracteres) y crédito de bienvenida de Google Cloud | Plan gratuito (10 000 créditos/mes, uso no comercial: sirve para la prueba) |

Fuentes consultadas el 12-11-2026: precios y capa gratuita de Cloud TTS, documentación de Chirp 3 HD, Gemini-TTS y Chirp 3 (STT) de Google; modelos, latencias y Scribe en la documentación de ElevenLabs; planes de ElevenLabs en sitios de terceros. Verificar precios vigentes antes de contratar.

## Decisiones

1. **Adaptador propio de voz** (`paquetes/voz`), igual que el de modelos: proveedor, motor, voz e idioma por configuración. Sin SDK de terceros; la firma del JWT de la cuenta de servicio de Google usa `node:crypto`.
2. **Turno completo, no streaming de audio de entrada**: la tablet graba hasta 1,6 s de silencio (pausas largas de personas mayores) o hasta que la persona toca el botón, y envía el audio. Se mide la latencia por etapa; si no alcanza, el siguiente paso es Scribe Live o el streaming de Chirp.
3. **Texto a voz por frases**: la primera frase suena mientras se sintetizan las demás. La respuesta también se muestra como subtítulo; si la síntesis falla, el texto queda en pantalla.
4. **El turno hablado pasa por el mismo orquestador** (detector de riesgo y guardián) que el escrito. No hay atajo de voz.
5. **Confianza baja → pedir repetir**, salvo que lo entendido ya traiga una señal de riesgo de nivel 2 o más (ante la duda, se procesa). Sin transcripción no se inventa un turno.
6. **Números de emergencia dígito por dígito** al hablar ("asterisco cuatro uno cuatro uno"), para que se puedan marcar al oírlos. Siguen viniendo de la configuración.
7. **El audio no se guarda.** Solo métricas en `medicion_voz` (latencias, confianza, duración, caracteres), que también sirven para el costo.
8. **Voces**: catálogo en `config/voz/voces.json`; la persona elige entre 3 ofrecidas (una grave) y ajusta la velocidad (0,7–1,2). Las ofrecidas se fijan con el resultado de la prueba ciega.
9. **Prueba ciega para decidir con las personas mayores**: una página HTML autocontenida (funciona sin internet) con las voces anonimizadas por letra, calificaciones de naturalidad, claridad y calidez, y elección final. La clave letra→voz queda en un archivo aparte.
10. **Benchmark de reconocimiento con métrica de seguridad**: además de WER y latencia, cuenta los *riesgos perdidos* (frases de riesgo que el detector deja de ver tras el reconocimiento).
11. **Prototipo web de la tablet** (`/tablet`) para el co-diseño, en vez de la app de Expo: permite probar voces y latencia en tablets reales desde ya. La app Expo en modo kiosco se construye en el Sprint 9. El micrófono del navegador exige HTTPS.

## Pendientes

- Completar los `voice_id` de ElevenLabs (`npm run voz:voces`) y correr la prueba ciega con personas mayores.
- Grabar según `docs/voz/protocolo-grabaciones.md` y correr el benchmark de reconocimiento.
- Probar con los proveedores reales (`VINCULAR_PRUEBA_VOZ_REAL=1`); en este entorno no hay credenciales.
- Agregar el costo de voz (caracteres y segundos de `medicion_voz`) al reporte de costos.
- Acuerdo de datos con el proveedor elegido (sección 9).
