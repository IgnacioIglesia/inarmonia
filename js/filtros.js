// filtros.js
// ------------------------------------------------------------------
// Acondicionamiento de la señal:
//  - biquads según las fórmulas RBJ (Audio EQ Cookbook de Robert Bristow-Johnson)
//  - pasa-altos Butterworth de orden 4 como cascada de 2 biquads
//  - notch (muesca) para el zumbido de 50 Hz de la red uruguaya
//  - filtfilt: filtrado ida y vuelta para fase cero
//  - respuesta en frecuencia de los filtros (módulo en dB)
//  - análisis del ruido previo para decidir si hay zumbido
// ------------------------------------------------------------------

import { espectroDeTramo } from './fft.js';

/**
 * Coeficientes de un biquad normalizado (a0 = 1).
 * Un biquad es un filtro IIR de 2º orden: la salida depende de 2 muestras
 * anteriores de entrada y 2 de salida. Su función de transferencia es
 *   H(z) = (b0 + b1·z⁻¹ + b2·z⁻²) / (1 + a1·z⁻¹ + a2·z⁻²)
 */
function coeficientesDesdeAlfa(b0, b1, b2, a0, a1, a2) {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/**
 * Biquad pasa-altos (RBJ). Deja pasar las frecuencias por encima de fc.
 * Q controla qué tan "agudo" es el codo: Q = 1/√2 da Butterworth de 2º orden.
 */
export function biquadPasaAltos(fc, fs, Q) {
  const w0 = (2 * Math.PI * fc) / fs;
  const cos = Math.cos(w0);
  const alfa = Math.sin(w0) / (2 * Q);
  return coeficientesDesdeAlfa(
    (1 + cos) / 2,
    -(1 + cos),
    (1 + cos) / 2,
    1 + alfa,
    -2 * cos,
    1 - alfa
  );
}

/**
 * Biquad notch (muesca, rechaza banda estrecha) centrado en f0.
 * Q alto = muesca angosta: el ancho de banda es aprox. f0/Q.
 * Con f0 = 50 Hz y Q = 30 el ancho es ~1.7 Hz: se come el zumbido sin tocar
 * notas que estén a más de unos pocos Hz.
 */
export function biquadNotch(f0, fs, Q) {
  const w0 = (2 * Math.PI * f0) / fs;
  const cos = Math.cos(w0);
  const alfa = Math.sin(w0) / (2 * Q);
  return coeficientesDesdeAlfa(
    1,
    -2 * cos,
    1,
    1 + alfa,
    -2 * cos,
    1 - alfa
  );
}

/**
 * Q de cada biquad de un Butterworth de orden par n.
 * Los polos de Butterworth están sobre un semicírculo; cada par de polos
 * conjugados forma un biquad con Q_k = 1 / (2·cos(π·(2k-1)/(2n))).
 * Para orden 4 da Q = 0.5412 y Q = 1.3066 (valores clásicos).
 */
export function qsButterworth(orden) {
  const qs = [];
  for (let k = 1; k <= orden / 2; k++) {
    qs.push(1 / (2 * Math.cos((Math.PI * (2 * k - 1)) / (2 * orden))));
  }
  return qs;
}

/**
 * Pasa-altos Butterworth de orden 4 = cascada de 2 biquads.
 * Por qué cascada y no un filtro de orden 4 directo: los biquads son
 * numéricamente estables; un filtro de orden alto en forma directa se
 * vuelve inestable con coeficientes en doble precisión y frecuencias bajas.
 * Devuelve la descripción completa para mostrarla en la interfaz.
 */
export function disenarPasaAltos(fc, fs, orden = 4) {
  const Qs = qsButterworth(orden);
  return {
    tipo: 'Pasa-altos Butterworth',
    orden,
    fc,
    Qs,
    secciones: Qs.map((Q) => ({ nombre: `HP Q=${Q.toFixed(4)}`, ...biquadPasaAltos(fc, fs, Q) })),
  };
}

/**
 * Procesa una señal con un biquad (forma directa II transpuesta).
 * Es la ecuación en diferencias del filtro, muestra a muestra:
 *   y[n] = b0·x[n] + z1
 *   z1   = b1·x[n] - a1·y[n] + z2
 *   z2   = b2·x[n] - a2·y[n]
 * z1 y z2 son la "memoria" del filtro (las muestras pasadas).
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

/**
 * Extensión "impar" de una señal en sus bordes.
 * Problema: al filtrar, el filtro arranca con memoria en cero y eso genera
 * un transitorio al principio y al final. Solución: agregar P muestras
 * reflejadas con simetría impar (2·x[0] - x[reflejado]) que mantienen la
 * pendiente y el valor en el borde. El transitorio cae en esas muestras
 * extra y después se descartan.
 */
function extenderImpar(x, P) {
  const N = x.length;
  const ext = new Float64Array(N + 2 * P);
  for (let i = 0; i < P; i++) {
    ext[P - 1 - i] = 2 * x[0] - x[i + 1];
    ext[P + N + i] = 2 * x[N - 1] - x[N - 2 - i];
  }
  ext.set(x, P);
  return ext;
}

/**
 * filtfilt: filtra hacia adelante y después hacia atrás.
 * Por qué: un filtro común desfasa la señal (retrasa distintas frecuencias
 * distinto). Al filtrar dos veces, en sentido inverso, el desfase se cancela
 * (fase cero). Eso preserva la posición temporal de los ataques y, sobre
 * todo, no mueve la frecuencia de los picos. La contrapartida es que el
 * módulo queda al cuadrado: la atenuación en dB se duplica.
 * Se aplica sección por sección: cada una es de fase cero, y la cascada también.
 */
export function filtfiltCascada(x, secciones, fs) {
  const N = x.length;
  // Padding de 1 s (o toda la señal si es más corta): cubre el transitorio del notch de Q alto.
  const P = Math.min(N - 1, Math.round(fs));
  let y = extenderImpar(x, P);
  for (const s of secciones) {
    y = pasarBiquad(y, s);
    y.reverse();
    y = pasarBiquad(y, s);
    y.reverse();
  }
  return y.slice(P, P + N);
}

/**
 * Respuesta en frecuencia (módulo en dB) de una cascada de biquads.
 * Evalúa H(e^{jw}) en cada frecuencia de la lista y multiplica las secciones
 * (en dB se suman). Sirve para el gráfico "respuesta en frecuencia" del informe.
 */
export function respuestaFrecuenciaDB(secciones, fs, frecuencias) {
  const dB = new Float64Array(frecuencias.length);
  for (let i = 0; i < frecuencias.length; i++) {
    const w = (2 * Math.PI * frecuencias[i]) / fs;
    let magnitud2 = 1;
    for (const s of secciones) {
      // e^{-jw} = c - j·s ; evaluamos numerador y denominador como polinomios en z⁻¹
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
 * Frecuencias de zumbido candidatas: 50 Hz y sus armónicos (100, 150, ...)
 * hasta un límite. Uruguay tiene red de 50 Hz. Limitamos a 1 kHz: a partir
 * de ahí el zumbido es muy débil y cada notch agrega costo y ruido de fase.
 */
export function frecuenciasDeZumbido(frecuenciaRed = 50, fMax = 1000) {
  const lista = [];
  for (let f = frecuenciaRed; f <= fMax; f += frecuenciaRed) lista.push(f);
  return lista;
}

/**
 * Decide qué notches aplicar. Regla del enunciado: un notch en f sólo se
 * aplica si f NO está a menos de `umbralHz` (3 Hz) de un armónico esperado
 * de la nota (k·f0). Si coincide, filtrarlo se comería la nota: no filtramos
 * y lo avisamos en el reporte.
 */
export function elegirNotches(frecuenciasZumbido, f0, umbralHz = 3, fs = 44100) {
  const aplicar = [];
  const omitir = [];
  for (const f of frecuenciasZumbido) {
    if (f >= fs / 2) continue;
    // Armónicos esperados de la nota hasta casi Nyquist.
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
 * Método: espectro con ventana BH; en cada armónico de 50 Hz buscamos el
 * máximo en ±1 Hz y lo comparamos con el "piso" local (mediana del espectro
 * entre ±5 y ±15 Hz). Si el pico supera el piso en 10 dB o más, es zumbido.
 */
export function analizarZumbido(segmentoRuido, fs, umbralDB = 10) {
  const esp = espectroDeTramo(segmentoRuido, fs);
  const frecuencias = frecuenciasDeZumbido(50, 500);
  const detectadas = [];
  for (const f of frecuencias) {
    const kCentro = Math.round(f / esp.df);
    const radio = Math.max(1, Math.round(1 / esp.df));
    // Pico dentro de ±1 Hz
    let kPico = kCentro;
    for (let k = kCentro - radio; k <= kCentro + radio; k++) {
      if (esp.dB[k] > esp.dB[kPico]) kPico = k;
    }
    // Piso local: mediana de los puntos entre ±5 y ±15 Hz (submuestreada para ir rápido)
    const piso = medianaDeVecindario(esp, kPico, 5, 15);
    const excesoDB = esp.dB[kPico] - piso;
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

// Mediana del espectro dB en dos anillos alrededor del bin k (±hzMin a ±hzMax).
function medianaDeVecindario(esp, k, hzMin, hzMax) {
  const kMin = Math.round(hzMin / esp.df);
  const kMax = Math.round(hzMax / esp.df);
  const valores = [];
  for (let d = kMin; d <= kMax; d += 2) {
    if (k - d >= 0) valores.push(esp.dB[k - d]);
    if (k + d < esp.dB.length) valores.push(esp.dB[k + d]);
  }
  valores.sort((a, b) => a - b);
  return valores[Math.floor(valores.length / 2)];
}
