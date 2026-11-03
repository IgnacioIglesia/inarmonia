# Inarmonía de notas: documento para la defensa

Pensado para defender el trabajo en 8 minutos. Todo el procesamiento usa herramientas del temario de la materia (Muestreo y Procesamiento Digital). Cada número de este documento sale de una prueba que corrimos. El [mapa del código](#10-mapa-dónde-está-cada-cosa-en-el-código) dice dónde está cada cosa.

---

## 0. Qué es del temario y qué no

| Herramienta | Tema del temario | Dónde se usa |
|---|---|---|
| Señales básicas, muestreo, fs, Nyquist | Señales básicas; Muestreo | Todo el proyecto |
| Ecuación en diferencias, forma de cascada | Ecuaciones en diferencias; Estructuras de filtros | `transformacionBilineal` da los coeficientes de la ecuación en diferencias de cada sección; el filtro es una cascada de secciones de orden 2 |
| Respuesta frecuencial | Respuesta frecuencial | `respuestaFrecuenciaDB` (gráfico c) y filtrado en fase cero |
| DFT / FFT | Transformada discreta de Fourier | `fft.js`, espectro de la nota |
| Zero-padding (muestrear la DFT más finamente) | Transformada discreta de Fourier | `calcularNFFT` |
| Ventana de Hann | Diseño de filtros FIR por ventanas; DFT | `ventana` en `fft.js` |
| Butterworth | Filtros en tiempo continuo | `disenarPasaAltosButterworth` |
| Transformación bilineal (Möbius) y prewarping | Diseño de filtros IIR | `transformacionBilineal` |
| Notch (muesca) | Diseño de filtros IIR (prototipo analógico + bilineal) | `disenarNotch` |
| Filtrado en fase cero (DFT) | Respuesta frecuencial + DFT | `filtrarFaseCero` |
| Autocorrelación | Procesos estocásticos | `autocorrelacion`, `estimarF0PorAutocorrelacion` |
| Potencia media, relación señal a ruido | Procesos estocásticos | `envolventeRMS` (potencia media por ventanas), `analizarZumbido` |
| Mínimos cuadrados (sistema lineal sobredeterminado) | Relación con álgebra lineal (respuesta frecuencial) | `ajustarB` |
| Nota musical, afinación en cents | **No es del temario**: es teoría musical, necesaria para el reporte | `nombreNota` |
| Modelo f_k = k·f0·√(1+B·k²) | **No es del temario**: es el modelo físico de la cuerda, lo define el enunciado | `buscarArmonicos`, `ajustarB` |
| Detección de onset, tramo sostenido | **No es del temario**: es segmentación, pedida por el enunciado | `detectarOnset`, `elegirTramo` |
| Parciales de vibráfono 1 : 4 : 10 | **No es del temario**: dato del instrumento, pedido por el enunciado | `analizarParciales` |

Las tres filas marcadas "no es del temario" son lo mínimo que pide el enunciado y no tienen reemplazo en el temario. Las demás piezas sí están cubiertas por el temario.

---

## 1. El problema y la física de la inarmonía

Una cuerda ideal vibra en armónicos exactos: si la fundamental es f0, los armónicos están en 2·f0, 3·f0, 4·f0, etc. Una cuerda real **tiene rigidez**: la rigidez hace que los armónicos altos queden un poco **más agudos** de lo que debería.

El modelo que usamos es:

**f_k = k · f0 · √(1 + B·k²)**

- **k** es el número de armónico (1, 2, 3, ...).
- **f0** es la frecuencia fundamental "ideal".
- **B** es el **coeficiente de inarmonía**. Cuanto más grande, más se desvían los armónicos altos.

Para una cuerda rígida, B ≈ π³·E·d⁴ / (64·T·L²), donde E es el módulo de Young, d el diámetro, T la tensión y L el largo vibrante. B crece con el **grosor** (a la cuarta potencia) y decrece con el **largo** (cuadrado). Por eso los **bajos de piano** (cuerdas gruesas y cortas) tienen B grande y los agudos tienen B casi nulo.

Números de referencia:

| Nota | f0 | B típico | Desvío del 10.º armónico por B | En cents |
|---|---|---|---|---|
| Bajo de piano | 55 Hz | 3·10⁻⁴ | 8.2 Hz | ≈ 26 cents |
| Nota media | 110 Hz | 1·10⁻⁴ | — | — |
| La 440 | 440 Hz | 1·10⁻⁵ | 2.2 Hz | ≈ 0.9 cents |

Por eso **las notas graves son el desafío**: el efecto de B es grande, pero hay pocos armónicos bien separados y la resolución en Hz es más pobre.

---

## 2. Pipeline completo

```mermaid
flowchart TD
  A[Entrada: archivo, micrófono o sintética] --> B[Preparar: mono, quitar DC, normalizar]
  B --> C[Potencia media por ventanas de 10 ms]
  C --> D[Onset: máxima subida en 30 ms]
  D --> E[Tramo sostenido: +150 ms, hasta 4 s o caída de 40 dB]
  B --> F[Segmento de ruido: 1 s previo al onset]
  F --> G{Zumbido de 50 Hz?}
  E --> H[DFT del tramo crudo]
  H --> I[f0 gruesa por autocorrelación, refinada con el espectro]
  I --> J[Butterworth pasa-altos bilineal, fc ≤ 0.5·f0]
  G -->|sí, y no coincide con la nota| K[Notches bilineales en 50 Hz y armónicos]
  J --> L[Filtrado en fase cero: DFT × |H|, sobre toda la grabación]
  K --> L
  L --> M[DFT con zero-padding del tramo filtrado]
  M --> N[Picos del espectro, paso 0.021 Hz]
  N --> O[Búsqueda de armónicos + ajuste de f0 y B por mínimos cuadrados]
  O --> P[Nota, afinación, tabla CSV, gráficos]
```

### Bloque por bloque

**Carga y preparación** (`js/audio.js`, `prepararSenal`)
- *Qué hace*: pasa a mono promediando canales, resta la media (quita DC) y normaliza al máximo = 1.
- *Por qué promediar canales*: la nota suena igual en ambos canales; promediar reduce el ruido que sea distinto en cada canal.
- *Por qué quitar DC*: una componente continua no es parte de la nota y ensucia el espectro en 0 Hz.

**Potencia por ventanas y onset** (`js/segmentacion.js`, `envolventeRMS`, `detectarOnset`)
- *Qué hace*: calcula la potencia media (valor cuadrático medio, RMS) en ventanas de 10 ms, en dB, y busca el ataque.
- *Decisión*: el onset es el instante de **máxima subida** de la envolvente en 30 ms.
- *Por qué*: el ataque sube muchos dB en pocos milisegundos; el ruido de fondo y el zumbido fluctúan poco.
- *Descartado*: umbral fijo ("cuando la envolvente llega a −30 dB del máximo") y subida fija de 15 dB. Ambos fallaron con zumbido fuerte (ver sección 5).

**Tramo sostenido** (`elegirTramo`)
- *Qué hace*: arranca 150 ms después del onset y dura hasta 4 s, o hasta que la potencia cae 40 dB.
- *Por qué 150 ms*: el primer instante de la nota tiene el golpe del martillo o la púa, que es ruido y no nota.
- *Por qué 4 s*: la resolución es Δf = fs/N. Cuatro segundos dan 0.25 Hz, suficiente para separar armónicos y medir B.

**Análisis de ruido y zumbido** (`analizarZumbido`)
- *Qué hace*: toma el segundo previo al onset, calcula su espectro (DFT con Hann) y mira si hay picos en 50, 100, 150... Hz que superen el nivel medio del entorno en 10 dB.
- *Decisión*: sólo filtramos los armónicos de 50 Hz que aparecieron de verdad.
- *Si no hay ruido previo*: pedimos un archivo de silencio opcional en la interfaz.

**Pasa-altos Butterworth bilineal** (`disenarPasaAltosButterworth`, `transformacionBilineal`)
- *Qué hace*: deja pasar frecuencias por encima de fc y atenúa lo de abajo (rumble, DC residual).
- *Cómo se diseña*: primero el prototipo **analógico** Butterworth de orden 4 (dos secciones de segundo orden con Q = 0.5412 y Q = 1.3066), y después la **transformación bilineal** s = 2·fs·(1 − z⁻¹)/(1 + z⁻¹) para pasarlo a tiempo discreto.
- *Prewarping*: la bilineal comprime las frecuencias. Por eso la frecuencia de corte analógica es Ω = 2·fs·tan(π·fc/fs), así el corte digital queda exactamente en fc.
- *Por qué orden 4 en dos secciones*: cada sección de orden 2 es numéricamente más estable que un filtro de orden 4 en una sola ecuación.
- *Por qué el límite 0.5·f0*: si el corte está demasiado alto se come la fundamental. Para f0 = 30 Hz, fc baja a 15 Hz.
- *Descartado*: Chebyshev, elíptico y Bessel (también del temario, pero Butterworth es el de respuesta más plana y el que pide el enunciado).

**Notch de 50 Hz** (`disenarNotch`, `elegirNotches`)
- *Qué hace*: elimina una frecuencia angosta. Prototipo analógico con ceros sobre el eje jω en ω0: H(s) = (s² + ω0²)/(s² + (ω0/Q)·s + ω0²), y después bilineal con prewarping.
- *Q = 30*: ancho ≈ 50/30 = 1.7 Hz.
- *Regla*: no se aplica si la frecuencia está a menos de 3 Hz de un armónico k·f0 de la nota. Si coincide, se omite y el reporte lo avisa.

**Filtrado en fase cero** (`filtrarFaseCero`)
- *Qué hace*: multiplica la DFT de la grabación por la magnitud |H(e^{jω})| de los filtros y vuelve al tiempo con la IDFT.
- *Por qué fase cero*: un filtro multiplica cada componente por un número complejo H. Si ese número es real y positivo (sólo módulo, fase 0), la señal no se desplaza en el tiempo. Los picos quedan en su lugar.
- *Cómo*: primero agregamos 1 s de ceros a cada lado (la DFT es circular; sin ese relleno el final se mezclaría con el principio). La IDFT se calcula con el truco de la conjugada.
- *Verificación*: un pulso en la muestra 22 050 sale en la muestra 22 050 (desplazamiento 0), con amplitud 1.000 en la banda de paso.
- *Descartado*: filtrar "ida y vuelta" en el tiempo (filtfilt), que no está en el temario.

**Espectro con zero-padding** (`js/fft.js`, `espectroDeTramo`)
- *Qué hace*: ventana de Hann → zero-padding hasta 2^21 puntos → DFT → magnitud en dB.
- *Por qué zero-padding*: no agrega información, sólo muestrea la misma DFT con más puntos. Así el paso del espectro es 0.021 Hz en vez de 0.25 Hz. Con eso los picos caen con un error de ±0.01 Hz.
- *Por qué Hann*: es la ventana del temario de diseño por ventanas. Sus lóbulos laterales (−31 dB el primero) alcanzaron para la validación (sección 5). Blackman-Harris también pasaba, pero no es del temario, así que la descartamos.

**Picos del espectro** (`detectarPicos`)
- *Qué hace*: busca máximos locales por encima de −70 dB del máximo y de la potencia media + 10 dB. Eliminamos duplicados a menos de 1 Hz.
- *Frecuencia del pico*: k·Δf del espectro con zero-padding (sin interpolación).

**f0 gruesa por autocorrelación** (`autocorrelacion`, `estimarF0PorAutocorrelacion`, `refinarF0ConPicos`)
- *Idea*: una señal periódica se parece a sí misma cuando la desplazamos un período T. La autocorrelación r[τ] = Σ x[n]·x[n+τ] tiene picos en τ = T, 2T, 3T...
- *Cómo se calcula*: por la DFT (teorema de Wiener-Khinchin): r = IDFT(|X|²), con relleno de ceros a 2N para no tener correlación circular.
- *Cómo se elige f0*: el **primer** máximo local con r ≥ 0.9 del máximo. Así no confundimos f0 con 2·f0: la correlación de 2·f0 es mucho menor porque sólo acierta en los armónicos pares.
- *Refinamiento*: la autocorrelación tiene resolución de 1 muestra (error de ~0.06 % en 55 Hz). Por eso buscamos el pico más alto del espectro dentro de ±1 % de la estimación y usamos su frecuencia.

**Búsqueda de armónicos y ajuste de B** (`buscarArmonicos`, `ajustarB`, `analizarArmonicos`)
- *Qué hace*: para k = 1, 2, 3... predice f_k = k·f0·√(1+B·k²), busca el pico más alto en una ventana y se detiene tras 3 k seguidos sin pico significativo o al llegar a fs/2.
- *Ventana*: tolerancia = min(0.4·f0, f_pred·(0.2 % + 0.05 %·k)). Crece con k, porque el error crece con k, y se corta en 0.4·f0 para no invadir al armónico vecino.
- *Ajuste*: elevamos al cuadrado y dividimos por k²: **(f_k / k)² = f0² + f0²·B·k²**. Es una recta y = a + b·x con x = k². Resolvemos el sistema sobredeterminado (muchos armónicos, dos incógnitas) por mínimos cuadrados. f0 = √a, B = b/a. R² indica qué tan bien la recta explica los datos.
- *Iteración*: empezamos con B = 0, ajustamos, volvemos a buscar con el B nuevo y repetimos hasta cuatro veces.

**Nota y afinación** (`nombreNota`)
- n = round(69 + 12·log₂(f0/440)): número MIDI de la nota más cercana.
- f_ideal = 440·2^((n−69)/12). Afinación en Hz = f0 − f_ideal; en cents = 1200·log₂(f0/f_ideal).
- *Por qué cents*: un cent es 1/100 de semitono. El oído distingue alrededor de 5 cents. Un mismo error en Hz pesa distinto según la nota: 0.05 Hz son 1.6 cents en 55 Hz, pero 0.2 cents en 440 Hz.

**Modo vibráfono** (`analizarParciales`)
- *Qué hace*: toma hasta 12 picos fuertes, descarta lóbulos laterales (un pico con otro más fuerte a menos de 2 Hz), ordena por frecuencia y toma el más grave como fundamental. Da la razón f/f0 de cada uno y la compara con la razón teórica más cercana (1, 4, 10).
- *Por qué no forzamos k·f0*: las barras de vibráfono no son armónicas.

---

## 3. Justificación numérica

| Parámetro | Valor | Por qué |
|---|---|---|
| Frecuencia de muestreo | la del archivo (44.1 o 48 kHz) | Nyquist = 22 kHz o 24 kHz, mucho más que cualquier armónico útil. |
| Largo del tramo | hasta 4 s | Resolución y estabilidad de la nota. |
| Δf del tramo (resolución real) | fs / N = 44100 / 176400 = **0.25 Hz** | Un semitono a 55 Hz son 3.3 Hz: sobra. |
| Tamaño de la DFT | **2^21 = 2 097 152** puntos | 8·N = 1 411 200 → siguiente potencia de 2 = 2^21. |
| Paso del espectro con zero-padding | 44100 / 2^21 = **0.021 Hz** | Es el paso de muestreo del espectro, no la resolución. Error máximo de un pico ±0.0105 Hz. |
| Ventana | Hann | Ver tabla de ventana abajo. |
| Pasa-altos | Butterworth orden 4, fc = 20 Hz, Q = 0.5412 y 1.3066 | Medido: −3.01 dB en 20 Hz, −0.33 dB en 27.5 Hz (A0), −0.02 dB en 40 Hz. |
| Notch | Q = 30, f = 50 Hz | Medido: −2.25 dB en 49 Hz, −2.33 dB en 51 Hz, −0.13 dB en 55 Hz, −0.11 dB en 45 Hz. |
| Umbral de picos | −70 dB del máximo | Corta el ruido de fondo y deja los armónicos débiles. |
| Significancia de un armónico | nivel medio del espectro + 15 dB | Dentro de una ventana de búsqueda hay cientos de bins de ruido, y su máximo queda unos 8 dB arriba del nivel medio. |

### Ventana de Hann: qué significa en la práctica

Medido sobre un seno de 200.3 Hz con 4 s:

| Medida | Hann | Qué significa |
|---|---|---|
| Semiancho del lóbulo principal (−3 dB) | 0.19 Hz | Cuánto ocupa el pico. |
| Lóbulo lateral entre 2 y 8 Hz del pico | −65.5 dB | Cuánta "fuga" hay alrededor del pico. |
| Teórico (primer lóbulo lateral) | −31 dB | Es el peor caso cerca del pico. |

Lo que importa para la nota: los armónicos altos están 60 a 70 dB por debajo del fundamental, pero están separados del vecino por f0 (cientos de Hz), así que la fuga a 2–8 Hz no los tapa. Por eso Hann alcanza.

**Nota sobre el gráfico c)**: muestra la respuesta del filtro. Como el filtrado en fase cero multiplica por |H| (no por |H|²), el gráfico coincide con lo que pasa realmente.

### Precisión de la f0 y de B

- Para f0 = 55 Hz, el criterio de 0.05 Hz equivale a **1.6 cents**. Para 440 Hz, equivale a **0.2 cents**.
- Para estimar B con 5 % de error en la nota de 440 Hz, hace falta medir el 10.º armónico con precisión de unos 0.1 Hz. Con el paso de 0.021 Hz de la DFT y el ajuste por mínimos cuadrados, el error medido es de milésimas de Hz (sección 5).

---

## 4. Ruidos e interferencias y cómo se tratan

| Fuente | Cómo se ve | Tratamiento |
|---|---|---|
| **Zumbido de red 50 Hz** y armónicos | Picos en 50, 100, 150... Hz en el ruido previo | Notch bilineal sólo si se detecta, y sólo si no coincide con un armónico de la nota (regla de 3 Hz). |
| **Ruido blanco** (electrónica, ambiente) | Piso plano de fondo | Lo vemos en el espectro del ruido. Umbral relativo (−70 dB) y significancia (+15 dB sobre el nivel medio). |
| **DC** | Un pico en 0 Hz y un desplazamiento | Restamos la media en `prepararSenal`. |
| **Ruido de ataque** (martillo, púa, dedo) | Ráfaga de ruido en los primeros ~50 ms | Empezamos el tramo 150 ms después del onset. |
| **Rumble y graves fuera de rango** | Energía por debajo de 20 Hz | Pasa-altos Butterworth orden 4. |
| **Fuga espectral** | Lóbulos laterales que tapan armónicos débiles | Ventana de Hann y separación de picos de al menos 1 Hz. |
| **Desfase del filtro** | Picos corridos en el tiempo | Filtrado en fase cero por la DFT. |
| **Efecto circular de la DFT** | El final de la señal se mezcla con el principio | 1 s de ceros a cada lado. |

### Caso en que el zumbido coincide con la nota

Si una nota está a menos de 3 Hz de un múltiplo de 50 Hz (por ejemplo, un G2 de 98 Hz está 2 Hz debajo de 100 Hz), **no se aplica el notch**: filtrarlo se comería la fundamental. El reporte lo avisa. Lo probamos con f0 = 150 Hz: el sistema omitió el notch en 150 Hz y la medición de armónicos fue correcta.

---

## 5. Resultados de la validación

La validación está en `test/test.html` y se ejecuta al abrir la página. Las señales se generan con f0 y B conocidos, con ruido blanco, zumbido de 50 Hz, ataque ruidoso y decaimiento exponencial. Criterios: error de f0 < 0.05 Hz y error relativo de B < 5 %.

Resultados de la versión final (sólo métodos del temario):

| Caso | f0 real (Hz) | f0 medida (Hz) | Error f0 (Hz) | B real | B medido | Error B (%) | Armónicos hallados / reales | Error máx. armónico (Hz) | Nota |
|---|---|---|---|---|---|---|---|---|---|
| Enunciado 1 | 55.00 | 54.9999 | −0.00005 | 3.0·10⁻⁴ | 3.0000·10⁻⁴ | 0.001 | 60 / 60 | 0.0120 | La1 |
| Enunciado 2 | 110.00 | 109.9999 | −0.00007 | 1.0·10⁻⁴ | 1.0000·10⁻⁴ | 0.001 | 60 / 60 | 0.0112 | La2 |
| Enunciado 3 | 440.00 | 440.0004 | 0.00041 | 1.0·10⁻⁵ | 1.0000·10⁻⁵ | −0.084 | 22 / 22 | 0.0095 | La4 |
| Ruido alto (σ = 0.03) | 55.00 | 54.9998 | −0.00017 | 3.0·10⁻⁴ | 3.0000·10⁻⁴ | 0.003 | 60 / 60 | 0.0423 | La1 |
| Zumbido fuerte (0.2) | 110.00 | 109.9999 | −0.00007 | 1.0·10⁻⁴ | 1.0000·10⁻⁴ | 0.001 | 60 / 60 | 0.0112 | La2 |
| Coincide con zumbido (150 Hz) | 150.00 | 150.0000 | −0.00005 | 2.0·10⁻⁴ | 2.0000·10⁻⁴ | 0.000 | 53 / 53 | 0.0115 | Re3 |

Otras pruebas hechas con el mismo sistema:

- **Casos extra** (f0 = 82.4 Hz con ruido; f0 = 30 Hz, donde fc baja a 15 Hz y el zumbido en 150 Hz se omite): todos dentro de criterio.
- **Archivo WAV real de prueba** (estéreo, 48 kHz, 16 bits, con zumbido y archivo de silencio aparte): detecta Mi2 (82.41 Hz) y B = 2.00·10⁻⁴. Probado subiendo el archivo en la interfaz de Chrome.
- **Modo vibráfono** (parciales 1 : 4 : 10 sintéticos): fundamental 196.007 Hz, razones 1.0000, 3.9999 y 9.9997.
- **Interfaz completa**: clic en "Cargar señal sintética", resumen, tabla de 60 filas y los seis gráficos. Sin errores de JavaScript.

### Cómo se llegó a este resultado

**Primera versión** (con métodos fuera del temario: onset con umbral fijo, interpolación parabólica, suma armónica, ventana Blackman-Harris): falló en los casos del enunciado.

| Caso | Error f0 | Error B | Observación |
|---|---|---|---|
| 55 Hz, B = 3·10⁻⁴ | +0.494 Hz | −103 % | R² = 0.52 |
| 110 Hz, B = 1·10⁻⁴ | exacto | exacto | — |
| 440 Hz, B = 1·10⁻⁵ | +0.362 Hz | −134 % | R² = 0.007, 24 armónicos hallados (22 reales) |

Cambios que hicimos en esa versión:

1. **Onset en 0 s**: el umbral fijo lo cruzaba el zumbido de fondo. Cambiamos a máxima subida de la envolvente.
2. **Falsos armónicos a k ≥ 23**: la ventana de búsqueda era muy ancha y el umbral de significancia era de 10 dB. Ajustamos la tolerancia y subimos el umbral a 15 dB.

**Segunda versión** (la actual): reemplazamos lo que no es del temario, con estos cambios:

| Antes (fuera del temario) | Ahora (del temario) | Efecto en la validación |
|---|---|---|
| Filtros RBJ (fórmulas de un libro de audio) | Butterworth analógico + transformación bilineal con prewarping | Mismo corte: −3.01 dB en 20 Hz |
| filtfilt (ida y vuelta en el tiempo) | Filtrado en fase cero por la DFT (multiplicar por \|H\|) | Pico sin desplazamiento |
| Interpolación parabólica sobre picos | Zero-padding: paso del espectro de 0.021 Hz | Error máx. de frecuencia de armónicos ≈ 0.01 Hz |
| Suma armónica para f0 | Autocorrelación + refinamiento con el espectro | f0 con error < 0.001 Hz |
| Blackman-Harris | Hann | Mismo resultado (los 8 casos pasaron con ambas) |
| Mediana del espectro | Nivel medio en dB | Mismo resultado |

Después de cada cambio corrimos la validación completa. El vibráfono tuvo una regresión (f0 194.9 Hz en vez de 196 Hz) porque el lóbulo lateral de Hann se tomaba como parcial. Lo corregimos descartando picos que tienen otro más fuerte a menos de 2 Hz.

---

## 6. Limitaciones conocidas

1. **Validamos sólo con señales sintéticas.** No tenemos grabaciones reales de piano o guitarra en el repositorio (la carpeta `audios/` está vacía). El modelo sintético es ideal: los armónicos decaen como k^(−1.2) y con un solo τ. Un piano real tiene cuerdas dobles o triples que producen batido, y decaimientos de dos etapas. Eso no está modelado.
2. **Fundamental débil o ausente.** La autocorrelación busca el primer período con correlación alta. Si el armónico 1 es muy débil, la correlación puede no reflejar f0. No lo probamos sistemáticamente.
3. **Notas cerca de un múltiplo de 50 Hz.** Si la nota está a menos de 3 Hz de 50·m, el zumbido queda sin filtrar y el armónico puede quedar contaminado.
4. **Sólo se filtra el zumbido de 50 Hz.** Otros ruidos (ventiladores, tonos de la sala) no se tratan.
5. **El onset y el tramo dependen del nivel.** Un ruido muy fuerte o un ataque suave pueden desplazar el onset unos 10–30 ms.
6. **La potencia por ventanas de 10 ms** tiene un rizado de ±3 dB en notas graves (un ciclo de 55 Hz dura 18 ms). No afecta a los umbrales usados.
7. **Tramos muy largos**: con más de 5.9 s, la DFT se queda en 2^21 puntos y el zero-padding baja de 8×. El filtrado en fase cero también crece con la duración (grabaciones de decenas de segundos tardan más).
8. **Modo vibráfono**: probado sólo con parciales sintéticos 1 : 4 : 10. Las razones reales de las barras varían un poco.
9. **Dependencia de internet para los gráficos**: Plotly se carga desde un CDN. El cálculo funciona igual sin internet, pero no se ven los gráficos.
10. **Grabación con micrófono**: requiere `localhost` o `https`, y depende de cómo el navegador codifica el audio.
11. **B puede salir negativo** si los armónicos están dispersos de forma irregular. Lo mostramos tal cual.

---

## 7. Guion sugerido para la presentación de 8 minutos

| Minuto | Qué decir | Qué mostrar |
|---|---|---|
| 0:00–1:00 | El problema: una cuerda real tiene rigidez; los armónicos se desvían; B mide cuánto. Por qué importan los graves. | Fórmula f_k = k·f0·√(1+B·k²) en una diapositiva. |
| 1:00–2:30 | Señal adquirida: qué tiene la grabación (nota, ruido, zumbido de 50 Hz). Cómo elegimos el tramo. | Gráfico **a)** (forma de onda, potencia y tramo sombreado). Gráfico **b)** (espectro del ruido con el 50 Hz marcado). |
| 2:30–4:00 | Acondicionamiento: Butterworth diseñado en analógico y pasado con la bilineal, notch, y filtrado en fase cero por la DFT. | Gráfico **c)** (respuesta de los filtros). Gráfico **d)** (antes y después del filtrado). |
| 4:00–5:30 | Análisis: DFT con zero-padding y paso de 0.021 Hz, autocorrelación para f0, búsqueda de armónicos, ajuste de B por mínimos cuadrados. | Gráfico **e)** (armónicos medidos sobre las líneas k·f0). |
| 5:30–6:30 | Resultado: nota, f0, afinación, B, R². | Resumen de la interfaz y la tabla de armónicos. Gráfico **f)** (desviación en cents vs k con la curva del modelo). |
| 6:30–7:30 | Validación: los casos sintéticos y los errores. Qué cambiamos cuando fallaba. | `test/test.html`: la tabla con los 6 casos OK. |
| 7:30–8:00 | Limitaciones (validación sintética, fundamental débil, zumbido cerca de 50 Hz) y cierre. | La sección 6 de este documento, en una diapositiva. |

### Pasos de la demo en vivo

1. Abrir `index.html` desde el servidor local (`python3 -m http.server 8000`).
2. Clic en **Cargar señal sintética de prueba**. Mostrar el resumen (La1, 55 Hz, B = 3·10⁻⁴).
3. Clic en **Grabar con micrófono**, tocar una nota (guitarra, piano o un silbido sostenido), y **Detener grabación**.
4. Mirar la sección de advertencias. Si hay zumbido, aparece el notch aplicado o omitido.
5. Descargar un PNG de un gráfico y exportar el CSV.
6. Abrir `test/test.html` y mostrar la tabla de validación.

---

## 8. Preguntas probables del tribunal

1. **¿Qué es B y por qué aparece?** Es el coeficiente de inarmonía. Aparece porque la cuerda tiene rigidez, que hace que los armónicos altos suban de frecuencia.
2. **¿Por qué no usar la DFT de la señal entera?** Porque la nota cambia (ataque, decaimiento) y el ruido del golpe ensucia el espectro. Analizamos un tramo estable de la nota.
3. **¿Cuál es la resolución en Hz?** Δf = fs/N = 0.25 Hz con 4 s a 44.1 kHz. El zero-padding no mejora la resolución, sólo muestrea la DFT más finamente (paso de 0.021 Hz).
4. **¿Qué es el zero-padding y por qué no es trampa?** Agregar ceros al final no crea información nueva: evalúa la DFT en más puntos. Sirve para localizar los picos con más precisión.
5. **¿Por qué ventana de Hann?** Es la ventana del temario. Reduce el efecto de los bordes del tramo (fuga espectral). Sus lóbulos laterales a −31 dB alcanzaron para medir los armónicos en la validación.
6. **¿Por qué Butterworth?** Tiene la respuesta más plana en la banda de paso, así que no cambia las amplitudes de los armónicos.
7. **¿Cómo se diseña un filtro digital a partir de uno analógico?** Diseñamos el prototipo analógico Butterworth y lo pasamos a tiempo discreto con la transformación bilineal s = 2fs·(1−z⁻¹)/(1+z⁻¹). Esa transformación no tiene aliasing, pero comprime las frecuencias; por eso usamos prewarping en la frecuencia de corte.
8. **¿Por qué el filtro es de orden 4 en dos secciones?** Dos secciones de orden 2, con Q = 0.5412 y 1.3066, dan el Butterworth de orden 4. En cascada son más estables numéricamente.
9. **¿Cómo lograron fase cero?** Multiplicamos la DFT de la grabación por la magnitud |H(ω)|, que es real y positiva. Como la fase es cero, la señal no se desplaza. Lo verificamos: un pulso sale en la misma muestra.
10. **¿Por qué el notch sólo se aplica si hay zumbido?** Un notch sobre una señal limpia sólo distorsiona. Y sólo si la frecuencia no coincide con la nota (regla de 3 Hz).
11. **¿Qué pasa si la nota está en 100 Hz?** Coincide con el armónico 100 Hz del zumbido. No se filtra (regla de 3 Hz), y el reporte lo avisa.
12. **¿Cómo detectan el onset?** Medimos la subida de la potencia por ventanas de 10 ms en 30 ms, y tomamos el punto de subida máxima. Un umbral fijo fallaba cuando había zumbido fuerte.
13. **¿Por qué 150 ms después del onset?** Para saltear el ruido del ataque (martillo, púa). Es un parámetro configurable en la interfaz.
14. **¿Cómo estiman la fundamental?** Con la autocorrelación: el período es la distancia al primer máximo fuerte. Tomamos el primero para no confundir f0 con 2·f0. Después refinamos con el pico más alto del espectro.
15. **¿Cómo ajustan f0 y B a la vez?** Elevamos al cuadrado (f_k/k)² y lo dividimos por k²: queda una recta en k². La ordenada es f0² y la pendiente f0²·B. Mínimos cuadrados, con R² para ver el ajuste.
16. **¿Por qué la afinación en cents y no en Hz?** Porque el cent es proporcional a la nota: 0.05 Hz son muy distintos en 55 Hz (1.6 cents) y en 440 Hz (0.2 cents).
17. **¿Qué precisión tienen los resultados?** Con los casos de validación, el error de f0 es menor a 10⁻³ Hz y el de B, menor a 0.1 %. Esto es con señales sintéticas.
18. **¿Por qué el vibráfono no es armónico?** Sus modos se aproximan a 1 : 4 : 10, no a 1 : 2 : 3. Por eso listamos los parciales y sus razones en vez de forzar k·f0.
19. **¿Funcionaría con piano real?** Lo probamos con señales sintéticas que incluyen la inarmonía. Con un piano real hay batido de cuerdas dobles, que no modelamos. Es una limitación que declaramos.
20. **¿Qué cosas usaron que no son del temario?** La teoría de notas musicales (MIDI, cents), el modelo físico de la cuerda y la detección de onset y de parciales. Son lo mínimo que pide el enunciado y no tienen reemplazo en el temario.

---

## 9. Decisiones de diseño

- **Agregamos `js/pipeline.js`** (no estaba en la estructura del enunciado). Así la validación y la interfaz usan exactamente el mismo código.
- **Filtros aplicados a toda la grabación**, no sólo al tramo, para que el filtrado tenga contexto.
- **Notch sólo en los armónicos de 50 Hz detectados** en el ruido, no en todos los hasta 1 kHz.
- **Referencia de amplitud relativa = armónico 1.** Si no se encuentra, usamos el más alto.
- **Archivo de silencio** se normaliza por separado. Sólo usamos su espectro relativo para detectar zumbido.
- **CSV con separador `;`** para que se abra bien en Excel en configuración española. Usamos punto decimal.
- **Modo vibráfono**: la fundamental es el parcial más grave, descartando lóbulos laterales. Las razones teóricas son 1, 4, 10, con tolerancia del 15 %.
- **Ventana por defecto: Hann.** Blackman-Harris se quitó porque no es del temario.

---

## 10. Mapa: dónde está cada cosa en el código

| Archivo | Función | Qué hace | Tema del temario |
|---|---|---|---|
| `js/audio.js` | `prepararSenal` | Mono, quita DC, normaliza. | Señales básicas |
| `js/audio.js` | `decodificarArchivo` | Lee WAV/MP3 con Web Audio API. | Muestreo (fs del archivo) |
| `js/audio.js` | `leerBitsWav` | Lee la profundidad de bits del encabezado WAV. | Representación numérica |
| `js/audio.js` | `iniciarGrabacion` | Grabación con micrófono (MediaRecorder). | — (herramienta del navegador) |
| `js/fft.js` | `fft` | FFT radix-2 in-place, con bit-reversal. | DFT / FFT |
| `js/fft.js` | `ventana` | Ventana de Hann. | Diseño por ventanas |
| `js/fft.js` | `calcularNFFT` | Tamaño de la DFT: 8·N, entre 2^19 y 2^21. | Zero-padding |
| `js/fft.js` | `espectroDeTramo` | Ventana, zero-padding, DFT y magnitud en dB. | DFT |
| `js/filtros.js` | `frecuenciaAnalogica` | Prewarping: Ω = 2·fs·tan(π·f/fs). | Transformación bilineal |
| `js/filtros.js` | `transformacionBilineal` | Pasa un prototipo analógico de orden 2 a z. | Diseño de filtros IIR |
| `js/filtros.js` | `qsButterworth` | Valores Q de las secciones de Butterworth. | Filtros en tiempo continuo |
| `js/filtros.js` | `disenarPasaAltosButterworth` | Pasa-altos Butterworth orden 4 (dos secciones). | Butterworth |
| `js/filtros.js` | `disenarNotch` | Notch de segundo orden, bilineal. | Diseño de filtros IIR |
| `js/filtros.js` | `respuestaFrecuenciaDB` | Módulo en dB de una cascada de secciones. | Respuesta frecuencial |
| `js/filtros.js` | `filtrarFaseCero` | Multiplica la DFT por \|H\| y vuelve al tiempo. | DFT + respuesta frecuencial |
| `js/filtros.js` | `analizarZumbido` | Busca 50 Hz y armónicos en el ruido previo. | Relación señal a ruido |
| `js/filtros.js` | `elegirNotches` | Regla de 3 Hz: aplicar u omitir cada notch. | — (regla propia) |
| `js/segmentacion.js` | `envolventeRMS` | Potencia media por ventanas de 10 ms, en dB. | Potencia (procesos estocásticos) |
| `js/segmentacion.js` | `detectarOnset` | Onset como máxima subida en 30 ms. | — (segmentación del enunciado) |
| `js/segmentacion.js` | `elegirTramo` | Tramo sostenido: +150 ms, hasta 4 s o caída de 40 dB. | — (segmentación del enunciado) |
| `js/segmentacion.js` | `segmentoPrevioAlOnset` | Segundo de ruido antes del ataque. | — |
| `js/armonicos.js` | `nivelMedioDB` | Nivel medio del espectro en dB. | Estadística básica |
| `js/armonicos.js` | `detectarPicos` | Máximos locales del espectro, umbral −70 dB, supresión de duplicados. | DFT |
| `js/armonicos.js` | `autocorrelacion` | r = IDFT(\|X\|²). | Autocorrelación |
| `js/armonicos.js` | `estimarF0PorAutocorrelacion` | f0 gruesa: primer máximo fuerte de la autocorrelación. | Autocorrelación |
| `js/armonicos.js` | `refinarF0ConPicos` | Refina f0 con el pico más alto del espectro. | DFT |
| `js/armonicos.js` | `buscarArmonicos` | Búsqueda de k con ventana que crece con k. | — (modelo del enunciado) |
| `js/armonicos.js` | `ajustarB` | Recta en k² por mínimos cuadrados; f0, B, R². | Álgebra lineal |
| `js/armonicos.js` | `analizarArmonicos` | Itera búsqueda y ajuste; arma la tabla. | — |
| `js/armonicos.js` | `analizarParciales` | Modo vibráfono: parciales y razones 1 : 4 : 10. | — (modo del enunciado) |
| `js/armonicos.js` | `nombreNota` | Nota MIDI, nombre (La4 / A4), afinación en Hz y cents. | — (teoría musical) |
| `js/pipeline.js` | `analizarNota` | Encadena todos los pasos en orden. | — |
| `js/graficos.js` | `graficaForma` … `graficaDesvio` | Los seis gráficos (a–f). | — |
| `js/graficos.js` | `diezmarMaximo` | Submuestreo por máximos para graficar sin saturar. | — |
| `js/main.js` | `analizar`, `mostrarResultados` | Conecta controles, pipeline y pantalla. | — |
| `js/main.js` | `exportarCSV` | Exporta la tabla a CSV. | — |
| `test/sintetica.js` | `generarNotaSintetica` | Nota con f0, B, ruido, zumbido y ataque conocidos. | Ruido blanco |
| `test/test.html` | `validarCaso` | Corre un caso y compara con la verdad. | — |
