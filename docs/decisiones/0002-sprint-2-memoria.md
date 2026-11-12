# 0002 · Sprint 2: memoria y personaje

Fecha: 12-11-2026 · Estado: aceptada

## Decisiones

1. **Extracción de memoria después de la sesión, no durante**: al cerrar la sesión (en segundo plano) o tras 30 minutos sin turnos (`npm run memoria:procesar`). Es idempotente, usa un bloqueo por sesión y reintenta hasta 5 veces; si el modelo falla no se escribe nada a medias.

2. **Citas verificadas por código** (mismo criterio que los informes clínicos): cada hecho, corrección, confirmación e historia repetida debe traer una cita literal de la persona que el código encuentra en sus turnos de esa sesión (comparación sin tildes ni mayúsculas, con palabras completas, mínimo dos palabras). Sin cita válida, se descarta y queda contado en la auditoría.

3. **Ningún diagnóstico que la persona no haya dicho**: ni en hechos, ni en resúmenes, ni en temas pendientes. Si ella misma lo cuenta ("el doctor me dijo que tengo diabetes"), se guarda.

4. **Confirmación implícita**: lo que extrae el sistema o anota el agente queda `por_confirmar`. El agente ve esos datos en una sección aparte, con su identificador, y retoma uno por conversación con tacto. La confirmación o corrección se registra con las herramientas `memoria_confirmar` / `memoria_corregir` o en la extracción siguiente (con cita). Solo los datos confirmados entran como "lo que sabes".

5. **"Olvidar" es borrar el hecho**. La transcripción clínica no se modifica (es registro clínico y la aplicación no puede alterarla). "Borrar toda la memoria" elimina hechos y memoria episódica y exige escribir "BORRAR TODO".

6. **Lo privado** se marca en las instrucciones del agente, lo ve el equipo clínico asignado y nunca el familiar (no existe ningún camino del familiar a la memoria).

7. **Memoria episódica**: un resumen por sesión (cifrado), temas pendientes y un embedding de 768 dimensiones del resumen. Sin modelo de embeddings (por ejemplo, si todo corre con Claude, que no los ofrece) la búsqueda cae a palabras sobre los resúmenes. Los vectores no van cifrados: se calculan sobre el resumen, no sobre la transcripción.

8. **La repetición de historias es una señal** (`senal.tipo = memoria.historia_repetida`), nunca un error que el agente corrija.

9. **La tablet es la persona**: puede conversar, administrar su memoria y diseñar su compañero, siempre solo para su propia persona. El perfil sigue sin admitir romance, pareja, imitación de un cónyuge ni humanidad fingida.

10. **Costos**: cada llamada a un modelo (incluidos embeddings y fallos) queda en `uso_modelo`. Los precios están en `config/precios-modelos.json`, nunca en el código; sin precio, el costo es `null` y el reporte lista el modelo faltante. Los meses se cortan en hora de Chile.

## Pendientes

- **Retención** (resumen a los 30 días, detalle hasta 6 meses, señales 12 meses): se implementa con el planificador del Sprint 8. TODO(clinico): confirmar qué significa "resumida" para el equipo clínico.
- **Completar `config/precios-modelos.json`** con los precios del contrato.
- **Probar la extracción y los embeddings con el proveedor real** (`VINCULAR_PRUEBA_IA_REAL=1`) y ajustar el prompt de extracción con conversaciones del co-diseño.
