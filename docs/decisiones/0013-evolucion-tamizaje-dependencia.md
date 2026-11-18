# 0013 · Evolución semanal, tamizaje conversacional y señal de dependencia

Fecha: 18-11-2026 · Estado: aceptada (umbrales y textos clínicos provisorios, `TODO(clinico)`)

## Contexto

La especificación pide un informe semanal de evolución (tendencias de ánimo, sueño, apetito, contacto humano, adherencia y lenguaje, comparadas con la línea base, con gráficos), tamizaje conversacional (GDS-15 y escala de soledad) en momentos definidos, una señal de dependencia ("si sube el tiempo de uso y baja el contacto humano durante 4 semanas") y que el supervisor pueda marcar cuando el agente se aparta del plan.

## Decisiones

### Indicadores por sesión
El resumen de sesión agrega `indicadores` (ánimo −2..2, sueño, apetito, contactos humanos que la persona contó). Cada uno solo se registra con una cita literal que lo sostenga, verificada por código; sin cita queda vacío.

### Evolución e informe semanal
- Las cifras las calcula el código desde la base, por semana (lunes a domingo, en la zona horaria de la persona): conversaciones, minutos, quién inició, nivel máximo, alertas, adherencia, ánimo, noches mal dormidas, apetito, contactos humanos e historias repetidas.
- **Línea base**: las dos primeras semanas con conversaciones.
- El informe de la semana anterior se genera cada lunes (el planificador revisa cada hora). La IA escribe solo una síntesis breve, validada como el resumen de sesión (citas literales de esa semana, comillas verificadas, sin diagnósticos). Si falla, el informe queda con las cifras.
- Panel: pestaña **Evolución** con 4 gráficos de una serie. Minutos de uso y contactos humanos van lado a lado, nunca en doble eje: el uso es una métrica de vigilancia, no de logro.

### Señal de dependencia
- Se comparan las 2 semanas completas más recientes con las 2 anteriores: el uso sube al menos 30 % y los contactos humanos bajan al menos 30 %. Sin contactos registrados antes, no se declara. `TODO(clinico)`: calibrar en el piloto.
- Si se detecta: queda una señal, el listado y la ficha la muestran ("Revisar dependencia") y, durante 7 días, el compañero refuerza el puente con otras personas (sin culpar, sin insistir y sin mencionar la indicación).

### Tamizaje conversacional (GDS-15 y UCLA-3)
- Lo inicia el supervisor asignado (especificación: línea base, 3 y 6 meses). Uno en curso por instrumento.
- El compañero pide permiso, hace una pregunta por vez cuando el clima lo permite, nunca con riesgo ni en emergencia (no recibe la indicación con nivel ≥ 2), no insiste y nunca comenta puntajes.
- Cada respuesta se registra con la frase literal de la persona, verificada contra lo que acaba de decir. Respuestas y citas, cifradas.
- El puntaje lo calcula el código. **GDS-15 ≥ 5 → alerta de nivel 2** (bandeja y cadena de avisos), como pide la tabla de niveles ("GDS elevado"); se usa el corte más bajo habitual porque los falsos negativos no se aceptan. UCLA-3 ≥ 6 → señal de nivel 1, sin alerta.
- `TODO(clinico)`: reemplazar los textos por la versión validada en Chile (GDS-15: Hoyl et al., 2000) y confirmar los cortes.

### Desvíos del agente
El supervisor marca, desde el resumen de una sesión, en qué se apartó el compañero del plan. Queda cifrado, con autor y fecha, como dato para mejorar el sistema.

## Pendiente
- Informe para consulta (síntesis del período para el profesional tratante, con autorización de la persona).
- Panel familiar con resumen de bienestar.
