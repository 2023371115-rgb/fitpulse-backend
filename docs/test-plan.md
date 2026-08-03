# FitPulse - Plan de pruebas Evaluacion 2

## Casos SA

| ID | Accion | Resultado esperado | Resultado real |
|---|---|---|---|
| TV-01 | Abrir `http://localhost:4200/?tv=1` con sesion iniciada | Carga pantalla fullscreen 10-foot | Pendiente demo |
| TV-02 | Presionar ArrowRight/ArrowLeft/ArrowUp/ArrowDown | El foco dorado se mueve sin romper limites | Pendiente demo |
| TV-03 | Presionar Enter sobre una tarjeta | La tarjeta queda seleccionada y cambia el estado TV | Pendiente demo |
| TV-04 | Registrar una meta desde telefono | TV recibe actualizacion por SSE en menos de 2 s | Pendiente cronometro |
| TV-05 | Registrar sesion desde telefono | TV muestra tarjeta Entrenamientos activa | Pendiente cronometro |
| TV-06 | Enviar metrica wearable a `/api/devices/:id/metrics` | TV cambia a Ritmo cardiaco | Pendiente demo |
| TV-07 | Desactivar red en DevTools | La pantalla conserva estructura desde cache/localStorage | Pendiente screenshot |
| TV-08 | Revisar 1920x1080 en DevTools | No hay scroll y respeta safe zone | Pendiente screenshot |

## Prueba D-pad

Orden esperado en grid 2x2:

- Arriba izquierda: Pasos.
- Arriba derecha: Ritmo cardiaco.
- Abajo izquierda: Entrenamientos.
- Abajo derecha: Dispositivos.

Al llegar al borde, el foco se queda dentro del grid.

## Pruebas ampliadas DE

| ID | Accion | Resultado esperado | Evidencia |
|---|---|---|---|
| DE-01 | Ejecutar Lighthouse sobre la PWA TV | Scores mayores a 80 | Pendiente reporte |
| DE-02 | Simular API apagada | TV muestra cache/localStorage y estado Offline cache | Pendiente screenshot |
| DE-03 | Forzar video inexistente | Se mantiene fondo poster CSS | Pendiente screenshot |
| DE-04 | Ejecutar GitHub Actions | Build Angular verde | Pendiente GitHub |

## Evidencias requeridas

- 3 screenshots de PWA en emulador 1920x1080.
- Video demo de 5 minutos.
- Reporte Lighthouse.
- Log de GitHub Actions con al menos 3 ejecuciones exitosas.
- Captura DevTools Application mostrando cache/localStorage con timestamp.
