# Inarmonía de notas

Herramienta web que mide la **inarmonía** de una nota sostenida de un instrumento de cuerda (piano, guitarra) o percusivo (vibráfono).

Dada una grabación, el sistema calcula:

- la **frecuencia fundamental f0**,
- la **nota musical** (afinación temperada, A4 = 440 Hz) y la **afinación** en Hz y cents,
- la **inarmonía B** (modelo f_k = k·f0·√(1+B·k²)) con su R²,
- la **frecuencia y amplitud** de cada armónico, y su **desviación** respecto de k·f0 y del modelo con B.

En modo vibráfono no se fuerza k·f0: se listan los parciales y su razón f/f0 frente a 1 : 4 : 10.

Todo corre en el navegador. El audio no sale de tu computadora.

La explicación de cada decisión de procesamiento está en [`RESUMEN.md`](RESUMEN.md).

## Qué hace la aplicación

1. **Entrada**: archivo WAV o MP3, grabación con micrófono, o una señal sintética de prueba.
2. **Segmentación**: envolvente RMS, detección del ataque (onset) y elección del tramo sostenido.
3. **Ruido**: análisis del tramo previo al ataque para detectar zumbido de red de 50 Hz.
4. **Filtrado**: pasa-altos Butterworth de orden 4 y notches en 50 Hz (sólo si hay zumbido), diseñados con la transformación bilineal y aplicados en fase cero por la DFT.
5. **Análisis**: FFT propia con ventana de Hann y zero-padding, picos sobre el espectro, f0 por autocorrelación, búsqueda de armónicos y ajuste de B por mínimos cuadrados.
6. **Salidas**: resumen, tabla exportable a CSV, y seis gráficos que se descargan en PNG.

## Cómo correrlo localmente

La página usa módulos de JavaScript, así que hay que abrirla desde un servidor estático (no alcanza con hacer doble clic en el archivo).

Desde la carpeta del proyecto:

```bash
python3 -m http.server 8000
```

Después abrí en el navegador: <http://localhost:8000>

Requisitos:

- Un navegador moderno (Chrome, Firefox o Safari).
- Conexión a internet para cargar **Plotly.js** desde el CDN (sólo para los gráficos; el cálculo funciona igual).
- Para grabar con micrófono, el navegador exige `localhost` o `https`.

## Validación

Abrí <http://localhost:8000/test/test.html>. La página genera notas sintéticas con f0 y B conocidos, las procesa y muestra una tabla con los errores. Los criterios son: error de f0 menor a 0.05 Hz y error relativo de B menor a 5 %.

## Publicar en GitHub Pages

1. Subí el repositorio a GitHub (el push lo hacen a mano).
2. En el repositorio, entrá a **Settings → Pages**.
3. En **Build and deployment**, elegí **Deploy from a branch**, rama `main`, carpeta `/ (root)`.
4. Guardá. Después de un minuto la página queda en `https://<usuario>.github.io/<repositorio>/`.

No hace falta ningún paso de compilación: el sitio es HTML, CSS y JavaScript tal como está.

## Estructura

```
index.html          interfaz principal
css/estilos.css     estilos
js/
  audio.js          carga de archivos, grabación y preparación de la señal
  fft.js            FFT radix-2, ventanas y espectro en dB
  filtros.js        Butterworth y notch (bilineal), filtrado en fase cero y análisis de zumbido
  segmentacion.js   envolvente RMS, onset y tramo sostenido
  armonicos.js      picos, autocorrelación, armónicos, ajuste de B, nota y afinación
  pipeline.js       encadena todos los pasos
  graficos.js       gráficos con Plotly
  main.js           conecta la interfaz con el pipeline
test/
  test.html         validación con señales sintéticas
  sintetica.js      generador de notas sintéticas
audios/             muestras de ejemplo (carpeta para sus archivos)
RESUMEN.md          documento para la defensa
```

## Formato del CSV

El archivo exportado usa `;` como separador (así se abre bien en Excel con configuración en español) y punto decimal.
