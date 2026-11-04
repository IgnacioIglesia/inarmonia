// filtros.js
// ------------------------------------------------------------------
// Acondicionamiento de la señal, sólo con herramientas del temario:
//  - filtros Butterworth en tiempo continuo (prototipo analógico)
//  - transformación bilineal (Möbius) para pasarlos a tiempo discreto
//  - filtrado de fase cero en el dominio de la frecuencia (DFT)
//  - respuesta en frecuencia (módulo en dB)
//  - análisis del ruido previo para detectar zumbido de 50 Hz
// ------------------------------------------------------------------

import { espectroDeTramo, fft, siguientePotenciaDe2 } from './fft.js';

/**
 * Pre-distorsión (prewarping) de la frecuencia de corte.
 * La transformación bilineal "comprime" el eje de frecuencias: una frecuencia
 * analógica Ω se transforma en una digital ω = 2·atan(Ω / (2fs)). Para que el
 * filtro digital tenga su corte exactamente en fc, diseñamos el prototipo
 * analógico con la frecuencia pre-distorsionada Ω = 2·fs·tan(π·fc/fs).
 */
export function frecuenciaAnalogica(f, fs) {
  return 2 * fs * Math.tan((Math.PI * f) / fs);
}

/**
 * Transformación bilineal de una sección de segundo orden.
 * Prototipo analógico: H(s) = (b2·s² + b1·s + b0) / (a2·s² + a1·s + a0)
 * Sustitución de Möbius: s = K·(1 - z⁻¹)/(1 + z⁻¹), con K = 2·fs.
 * Multiplicando numerador y denominador por (1 + z⁻¹)² queda una función
 * de z⁻¹ de segundo orden, cuyos coeficientes salen de expandir los términos.
 * Devuelve la sección normalizada (a0 = 1) en la forma
 *   H(z) = (b0 + b1·z⁻¹ + b2·z⁻²) / (1 + a1·z⁻¹ + a2·z⁻²)
 * Por qué bilineal: mapea todo el eje analógico (0 a ∞) dentro de 0 a fs/2
 * sin solapamiento (no hay aliasing en el diseño), a costo de distorsionar
 * las frecuencias altas; por eso usamos prewarping en la frecuencia de corte.
 */

export function transformacionBilineal(b, a, fs) {
  const [b2, b1, b0] = b;
  const [a2, a1, a0] = a;
  const K = 2 * fs;
  const K2 = K * K;

  const n0 = b2 * K2 + b1 * K + b0;
  const n1 = -2 * b2 * K2 + 2 * b0;
  const n2 = b2 * K2 - b1 * K + b0;
  const d0 = a2 * K2 + a1 * K + a0;
  const d1 = -2 * a2 * K2 + 2 * a0;
  const d2 = a2 * K2 - a1 * K + a0;

  return { b0: n0 / d0, b1: n1 / d0, b2: n2 / d0, a1: d1 / d0, a2: d2 / d0 };
}

/**
 * Valores Q de las secciones de un Butterworth de orden par n.
 * Los polos del Butterworth analógico están sobre un semicírculo; cada par de
 * polos conjugados es una sección de segundo orden con
 *   Q_k = 1 / (2·cos(π·(2k-1)/(2n))).
 * Para n = 4 da Q = 0.5412 y Q = 1.3066.
 */
export function qsButterworth(orden) {
  const qs = [];
  for (let k = 1; k <= orden / 2; k++) {
    qs.push(1 / (2 * Math.cos((Math.PI * (2 * k - 1)) / (2 * orden))));
  }
  return qs;
}

/**
 * Pasa-altos Butterworth de orden 4 (dos secciones de segundo orden).
 * Prototipo analógico pasa-altos: H(s) = s² / (s² + (ωc/Q)·s + ωc²).
 * Lo aplicamos a cada sección con su Q y lo pasamos con la bilineal.
 * Por qué cascada de secciones de orden 2: un filtro de orden 4 en forma
 * directa es numéricamente frágil; en cascada cada sección es más estable.
 */
export function disenarPasaAltosButterworth(fc, fs, orden = 4) {
  const wc = frecuenciaAnalogica(fc, fs);
  const Qs = qsButterworth(orden);
  return {
    tipo: 'Pasa-altos Butterworth (bilineal)',
    orden,
    fc,
    Qs,
    secciones: Qs.map((Q) => ({
      nombre: `HP Q=${Q.toFixed(4)}`,
      ...transformacionBilineal([1, 0, 0], [1, wc / Q, wc * wc], fs),
    })),
  };
}

/**
 * Notch (muesca) de segundo orden: rechaza una banda angosta alrededor de f0.
 * Prototipo analógico: H(s) = (s² + ω0²) / (s² + (ω0/Q)·s + ω0²).
 * Tiene ceros exactamente sobre el eje jω en ω0, así que ahí la ganancia es 0.
 * El ancho de banda es aprox. f0/Q: con f0 = 50 Hz y Q = 30 es ~1.7 Hz.
 */
export function disenarNotch(f0, fs, Q = 30) {
  const w0 = frecuenciaAnalogica(f0, fs);
  return {
    f0,
    Q,
    nombre: `Notch ${f0} Hz`,
    ...transformacionBilineal([1, 0, w0 * w0], [1, w0 / Q, w0 * w0], fs),
  };
}

/**
 * Respuesta en frecuencia (módulo en dB) de una cascada de secciones.
 * Evalúa H(e^{jω}) = (b0 + b1·e^{-jω} + b2·e^{-j2ω}) / (1 + a1·e^{-jω} + a2·e^{-j2ω})
 * en cada frecuencia y multiplica las secciones (en dB se suman).
 * Es la respuesta del temario: |H(e^{jω})| evaluada sobre el círculo unitario.
 */
export function respuestaFrecuenciaDB(secciones, fs, frecuencias) {
  const dB = new Float64Array(frecuencias.length);
  for (let i = 0; i < frecuencias.length; i++) {
    const w = (2 * Math.PI * frecuencias[i]) / fs;
    let magnitud2 = 1;
    for (const s of secciones) {
      const cw = Math.cos(w), sw = Math.sin(w);
      const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
      const nRe = s.b0 + s.b1 * cw + s.b2 * c2;
      const nIm = -(s.b1 * sw + s.b2 * s2);
      const dRe = 1 + s.a1 * cw + s.a2 * c2;
      const dIm = -(s.a1 * sw + s.a2 * s2);
      magnitud2 *= (nRe * nRe + nIm * nIm) / (dRe * dRe + dIm * dIm);
    }
    dB[i] = 10 * Math.log10(magnitud2 + 1e-20);
  }
  return dB;
}

/**
 * Filtrado de fase cero en el dominio de la frecuencia.
 * Idea: en la DFT, filtrar es multiplicar Y(k) = H(k)·X(k). Si H(k) es real y
 * positiva (sólo módulo, fase 0), la salida no tiene desfase: los picos quedan
 * en el mismo instante y en la misma frecuencia. Así obtenemos fase cero
 * sin usar un filtro "ida y vuelta" (que no está en el temario).
 * Pasos: zero-padding de 1 s a cada lado (la DFT es circular: sin padding el
 * final se mezclaría con el principio) → FFT → multiplicar por |H| → IFFT.
 * La IFFT se calcula con el truco de la conjugada: IFFT(X) = conj(FFT(conj(X)))/M.
 */
export function filtrarFaseCero(x, secciones, fs) {
  const N = x.length;
  const P = Math.round(fs);
  const M = siguientePotenciaDe2(N + 2 * P);

  const re = new Float64Array(M);
  const im = new Float64Array(M);
  re.set(x, P);
  fft(re, im);

  // Módulo de H en cada bin. La DFT de una señal real es simétrica: k y M-k tienen la misma magnitud.
  const mitad = M / 2;
  const frecuencias = new Float64Array(mitad + 1);
  for (let k = 0; k <= mitad; k++) frecuencias[k] = (k * fs) / M;
  const magnitudDB = respuestaFrecuenciaDB(secciones, fs, frecuencias);

  for (let k = 0; k < M; k++) {
    const g = 10 ** (magnitudDB[k <= mitad ? k : M - k] / 20);
    re[k] *= g;
    im[k] *= g;
  }

  // IFFT con la conjugada (la parte real no cambia al conjugar).
  for (let k = 0; k < M; k++) im[k] = -im[k];
  fft(re, im);

  const y = new Float64Array(N);
  for (let n = 0; n < N; n++) y[n] = re[n + P] / M;
  return y;
}

/**
 * Frecuencias de zumbido candidatas: 50 Hz y sus armónicos (100, 150, ...)
 * hasta un límite. Uruguay tiene red de 50 Hz. Limitamos a 1 kHz.
 */
export function frecuenciasDeZumbido(frecuenciaRed = 50, fMax = 1000) {
  const lista = [];
  for (let f = frecuenciaRed; f <= fMax; f += frecuenciaRed) lista.push(f);
  return lista;
}

/**
 * Decide qué notches aplicar. Regla: un notch en f sólo se aplica si f NO
 * está a menos de `umbralHz` (3 Hz) de un armónico esperado de la nota (k·f0).
 * Si coincide, filtrarlo se comería la nota: no filtramos y lo avisamos.
 */
export function elegirNotches(frecuenciasZumbido, f0, umbralHz = 3, fs = 44100) {
  const aplicar = [];
  const omitir = [];
  for (const f of frecuenciasZumbido) {
    if (f >= fs / 2) continue;
    let cercano = null;
    for (let k = 1; k * f0 < fs / 2; k++) {
      const d = Math.abs(f - k * f0);
      if (d < umbralHz) {
        cercano = { k, distanciaHz: d };
        break;
      }
    }
    if (cercano) {
      omitir.push({ f, motivo: `coincide con el armónico ${cercano.k} de la nota (a ${cercano.distanciaHz.toFixed(2)} Hz)` });
    } else {
      aplicar.push(f);
    }
  }
  return { aplicar, omitir };
}

/**
 * Análisis del ruido: busca zumbido de red en un segmento que contiene sólo
 * ruido (antes del ataque de la nota).
 * Método: espectro con ventana; en cada armónico de 50 Hz buscamos el máximo
 * en ±1 Hz y lo comparamos con el nivel medio en dB de un entorno (entre ±5 y
 * ±15 Hz). Si el pico supera ese nivel en 10 dB o más, es zumbido.
 */
export function analizarZumbido(segmentoRuido, fs, umbralDB = 10, ventana = 'hann') {
  const esp = espectroDeTramo(segmentoRuido, fs, { ventana });
  const frecuencias = frecuenciasDeZumbido(50, 500);
  const detectadas = [];
  for (const f of frecuencias) {
    const kCentro = Math.round(f / esp.df);
    const radio = Math.max(1, Math.round(1 / esp.df));
    let kPico = kCentro;
    for (let k = kCentro - radio; k <= kCentro + radio; k++) {
      if (esp.dB[k] > esp.dB[kPico]) kPico = k;
    }
    const nivel = promedioDBDeVecindario(esp, kPico, 5, 15);
    const excesoDB = esp.dB[kPico] - nivel;
    if (excesoDB >= umbralDB) {
      detectadas.push({ f: kPico * esp.df, excesoDB });
    }
  }
  return {
    detectado: detectadas.length > 0,
    frecuencias: detectadas,
    espectro: esp,
  };
}

// Promedio aritmético en dB de los puntos del espectro en dos anillos alrededor del bin k.
function promedioDBDeVecindario(esp, k, hzMin, hzMax) {
  const kMin = Math.round(hzMin / esp.df);
  const kMax = Math.round(hzMax / esp.df);
  let suma = 0;
  let cuenta = 0;
  for (let d = kMin; d <= kMax; d += 2) {
    if (k - d >= 0) { suma += esp.dB[k - d]; cuenta++; }
    if (k + d < esp.dB.length) { suma += esp.dB[k + d]; cuenta++; }
  }
  return suma / cuenta;
}
