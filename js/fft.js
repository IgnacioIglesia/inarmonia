// fft.js
// ------------------------------------------------------------------
// Transformada rápida de Fourier (FFT) escrita a mano, ventanas de
// ponderación (Hann) y la función que convierte un
// tramo de señal en un espectro de magnitud en dB.
// Todo usa Float64Array para tener la precisión de doble coma flotante.
// ------------------------------------------------------------------

// Cache de tablas de giros (cos/sin) para no recalcularlas en cada FFT.
const cacheDeGiros = new Map();

/**
 * Devuelve el menor entero potencia de 2 que es >= n.
 * La FFT radix-2 sólo funciona con longitudes que sean potencias de 2:
 * por eso se rellena la señal con ceros (zero-padding) hasta esa longitud.
 */
export function siguientePotenciaDe2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * Tabla de factores de giro W_N^k = e^{-j·2π·k/N} para k = 0..N/2-1.
 * Guardamos el coseno y el seno del ángulo 2πk/N: son los que usa la
 * mariposa de la FFT. Se calculan una sola vez por cada tamaño N.
 */
function tablaDeGiros(N) {
  if (cacheDeGiros.has(N)) return cacheDeGiros.get(N);
  const mitad = N / 2;
  const cos = new Float64Array(mitad);
  const sin = new Float64Array(mitad);
  for (let k = 0; k < mitad; k++) {
    const angulo = (2 * Math.PI * k) / N;
    cos[k] = Math.cos(angulo);
    sin[k] = Math.sin(angulo);
  }
  const tabla = { cos, sin };
  cacheDeGiros.set(N, tabla);
  return tabla;
}

/**
 * Reordena las muestras por "inversión de bits" (bit-reversal).
 * La FFT iterativa necesita que, antes de empezar, los elementos estén en
 * el orden que resulta de leer los índices con los bits al revés. Así, al
 * combinar pares en cada etapa, el resultado queda en orden natural.
 */
function reordenarPorBitReversal(re, im) {
  const N = re.length;
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
}

/**
 * FFT in-place (Cooley-Tukey, base 2).
 * re e im: Float64Array de longitud N (potencia de 2), parte real e imaginaria.
 * Idea: la DFT de N puntos se parte en dos DFT de N/2 (muestras pares e
 * impares) y se combinan con los factores de giro. Costo N·log2(N) operaciones
 * en vez de N², que es lo que hace viable analizar 2 millones de puntos.
 * Al terminar, re/im contienen X[k] = Σ x[n]·e^{-j2πkn/N}.
 */
export function fft(re, im) {
  const N = re.length;
  reordenarPorBitReversal(re, im);
  const { cos, sin } = tablaDeGiros(N);

  // Etapas: tamaño de mariposa 2, 4, 8, ... N.
  for (let tam = 2; tam <= N; tam <<= 1) {
    const mitad = tam >> 1;
    // Salto en la tabla de giros: para mariposas más grandes el giro es más "fino".
    const salto = N / tam;
    for (let inicio = 0; inicio < N; inicio += tam) {
      for (let k = 0; k < mitad; k++) {
        const c = cos[k * salto];
        const s = sin[k * salto];
        const a = inicio + k;
        const b = a + mitad;
        // Producto complejo (re[b] + j·im[b]) · (c - j·s)
        const tr = re[b] * c + im[b] * s;
        const ti = im[b] * c - re[b] * s;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/**
 * Ventana de Hann de N puntos: w[n] = 0.5 - 0.5·cos(2πn/(N-1)).
 * Por qué existe: al cortar un tramo finito de señal aparecen "bordes" que
 * esparcen la energía de cada senoide hacia otras frecuencias (fuga espectral).
 * La ventana va a cero en los bordes y así el corte es suave.
 * Compromiso: lóbulo principal angosto (buena resolución) con lóbulos
 * laterales a -31 dB. Para este proyecto alcanza: la validación lo confirma.
 * Es la ventana "de diseño por ventanas" vista en el temario.
 */
export function ventana(tipo, N) {
  if (tipo !== 'hann') throw new Error(`Ventana no soportada: ${tipo}`);
  const w = new Float64Array(N);
  const M = N - 1;
  for (let n = 0; n < N; n++) {
    w[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / M);
  }
  return w;
}

/**
 * Número de puntos de la FFT para un tramo de N muestras.
 * Regla del enunciado: al menos 8·N (zero-padding), mínimo 2^19 y máximo 2^21.
 * El zero-padding NO agrega información: sólo muestrea el mismo espectro más
 * finamente (interpolación), lo que ayuda a localizar picos con precisión.
 */
export function calcularNFFT(N) {
  const minimo = 2 ** 19;
  const maximo = 2 ** 21;
  const pedido = Math.max(siguientePotenciaDe2(8 * N), minimo);
  return Math.max(siguientePotenciaDe2(N), Math.min(pedido, maximo));
}

/**
 * Espectro de magnitud de un tramo de señal.
 * Pasos: ventana → zero-padding hasta nFFT → FFT → módulo → dB.
 * La magnitud se calibra dividiendo por la suma de la ventana (2/Σw), así que
 * un seno de amplitud A aparece con magnitud ≈ A en el pico. Eso permite
 * hablar de "amplitud" y de "dB" de forma coherente.
 * Devuelve también df = fs/nFFT: la separación entre puntos del espectro.
 */
export function espectroDeTramo(tramo, fs, opciones = {}) {
  const tipoVentana = opciones.ventana ?? 'hann';
  const N = tramo.length;
  const nFFT = opciones.nFFT ?? calcularNFFT(N);
  const w = ventana(tipoVentana, N);

  let sumaW = 0;
  for (let n = 0; n < N; n++) sumaW += w[n];

  const re = new Float64Array(nFFT);
  const im = new Float64Array(nFFT);
  for (let n = 0; n < N; n++) re[n] = tramo[n] * w[n];
  fft(re, im);

  // Sólo nos interesa la mitad positiva (la señal es real: el espectro es simétrico).
  const M = nFFT / 2 + 1;
  const mag = new Float64Array(M);
  const dB = new Float64Array(M);
  for (let k = 0; k < M; k++) {
    mag[k] = (2 * Math.hypot(re[k], im[k])) / sumaW;
    dB[k] = 20 * Math.log10(mag[k] + 1e-12);
  }

  return {
    fs,
    nFFT,
    nTramo: N,
    ventana: tipoVentana,
    df: fs / nFFT,          // resolución del muestreo del espectro (con zero-padding)
    dfTramo: fs / N,        // resolución real: Δf = fs / N_tramo
    mag,
    dB,
  };
}
