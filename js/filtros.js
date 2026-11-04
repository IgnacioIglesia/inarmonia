// filtros.js
// ------------------------------------------------------------------
// Eliminación del zumbido de red (50 Hz y armónicos):
//  - diseño de un notch analógico y pasaje a tiempo discreto (transformación bilineal)
//  - filtrado en el tiempo con la ecuación en diferencias del biquad
//  - respuesta en frecuencia del filtro (módulo en dB)
//  - detección del zumbido en un segmento con sólo ruido
// ------------------------------------------------------------------

import { espectroDeTramo } from './fft.js';

/**
 * Frecuencia analógica equivalente (prewarping) de una frecuencia digital f.
 * La transformación bilineal comprime el eje de frecuencias. Para que el notch
 * digital quede centrado exactamente en f, diseñamos el prototipo analógico con
 * Ω = 2·fs·tan(π·f/fs).
 */
export function frecuenciaAnalogica(f, fs) {
  return 2 * fs * Math.tan((Math.PI * f) / fs);
}

/**
 * Transformación bilineal (Möbius) de una sección de segundo orden.
 * Prototipo analógico: H(s) = (b2·s² + b1·s + b0) / (a2·s² + a1·s + a0)
 * Sustitución: s = K·(1 - z⁻¹)/(1 + z⁻¹), con K = 2·fs.
 * Multiplicando por (1 + z⁻¹)² queda una función de z⁻¹ de segundo orden.
 * Devuelve la sección normalizada (a0 = 1):
 *   H(z) = (b0 + b1·z⁻¹ + b2·z⁻²) / (1 + a1·z⁻¹ + a2·z⁻²)
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
 * Notch de segundo orden centrado en f0.
 * Prototipo analógico: H(s) = (s² + ω0²) / (s² + (ω0/Q)·s + ω0²).
 * Tiene ceros sobre el eje jω en ω0, así que en esa frecuencia la ganancia es cero.
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
 * Filtra una señal con una sección (ecuación en diferencias, forma directa II transpuesta):
 *   y[n] = b0·x[n] + z1
 *   z1   = b1·x[n] - a1·y[n] + z2
 *   z2   = b2·x[n] - a2·y[n]
 * z1 y z2 guardan las muestras pasadas que el filtro necesita.
 */
export function pasarBiquad(x, s) {
  const y = new Float64Array(x.length);
  let z1 = 0;
  let z2 = 0;
  for (let n = 0; n < x.length; n++) {
    const salida = s.b0 * x[n] + z1;
    z1 = s.b1 * x[n] - s.a1 * salida + z2;
    z2 = s.b2 * x[n] - s.a2 * salida;
    y[n] = salida;
  }
  return y;
}

/** Aplica en cascada una lista de secciones (cada notch) sobre la señal. */
export function aplicarFiltros(x, secciones) {
  let y = x;
  for (const s of secciones) y = pasarBiquad(y, s);
  return y;
}

/**
 * Respuesta en frecuencia (módulo en dB) de una cascada de secciones.
 * Evalúa H(e^{jω}) en cada frecuencia de la lista, sobre el círculo unitario.
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
 * Frecuencias de zumbido candidatas: 50 Hz y sus armónicos (100, 150...) hasta 500 Hz.
 * Uruguay tiene red de 50 Hz.
 */
export function frecuenciasDeZumbido(frecuenciaRed = 50, fMax = 500) {
  const lista = [];
  for (let f = frecuenciaRed; f <= fMax; f += frecuenciaRed) lista.push(f);
  return lista;
}

/**
 * Decide qué notches aplicar. Si una frecuencia del zumbido está a menos de
 * `umbralHz` (3 Hz) de un armónico de la nota, no se filtra: el notch se comería
 * la nota. Esa decisión se informa en el reporte.
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
 * Detecta zumbido en un segmento con sólo ruido.
 * En cada armónico de 50 Hz buscamos el máximo del espectro en ±1 Hz y lo
 * comparamos con el nivel medio en dB de un entorno (entre ±5 y ±15 Hz).
 * Si supera ese nivel en 10 dB o más, es zumbido.
 */
export function analizarZumbido(segmentoRuido, fs, umbralDB = 10) {
  const esp = espectroDeTramo(segmentoRuido, fs);
  const detectadas = [];
  for (const f of frecuenciasDeZumbido()) {
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

// Promedio en dB de los puntos del espectro en dos anillos alrededor del bin k.
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
