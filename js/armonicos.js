// armonicos.js
// ------------------------------------------------------------------
// Análisis del espectro de la nota, sólo con herramientas del temario:
//  - detección de picos sobre la DFT con zero-padding (la precisión sub-bin
//    la da el zero-padding: el paso del espectro es fs/N_FFT)
//  - estimación de f0 por autocorrelación (Procesos estocásticos)
//  - búsqueda de armónicos con el modelo f_k = k·f0·√(1+B·k²)
//  - ajuste de f0 y B por mínimos cuadrados (álgebra lineal: sistema sobredeterminado)
//  - nota musical y afinación (temperamento igual, A4 = 440 Hz)
//  - modo vibráfono: parciales comparados con 1 : 4 : 10
// ------------------------------------------------------------------

import { fft, siguientePotenciaDe2 } from './fft.js';

// Un pico es "significativo" si supera el nivel medio del espectro (en dB) en 15 dB.
// Dentro de una ventana de búsqueda hay muchos bins de ruido; su máximo queda unos
// 8 dB por encima del nivel medio. Con 10 dB aparecían armónicos falsos.
const EXCESO_SIGNIFICATIVO_DB = 15;
// La búsqueda de armónicos se detiene tras 3 k seguidos sin pico significativo.
const MAX_FALTAS_SEGUIDAS = 3;
// Límite de armónicos a buscar (en la práctica se corta antes por fs/2 o por falta de energía).
const K_MAX = 200;

const NOMBRES_ES = ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];
const NOMBRES_EN = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Nivel medio del espectro en dB: promedio aritmético de todos los bins.
 * Es el "piso" de referencia para decidir si un pico es significativo.
 * Usamos el promedio de dB (y no de potencia) porque los pocos picos fuertes
 * casi no lo desplazan: sus valores en dB son pocos frente a millones de bins de ruido.
 */
export function nivelMedioDB(espectro) {
  const dB = espectro.dB;
  let suma = 0;
  for (let k = 0; k < dB.length; k++) suma += dB[k];
  return suma / dB.length;
}

/**
 * Detección de picos.
 * Un pico es un máximo local (más alto que sus vecinos) que además:
 *   1) está a menos de `umbralDB` (−70 dB) del máximo global, y
 *   2) supera el nivel medio del espectro en 10 dB (candidatos) — la
 *      significancia fuerte (15 dB) se aplica después, al buscar armónicos.
 * La frecuencia del pico es k·Δf, con Δf = fs/N_FFT (0.021 Hz con zero-padding).
 * Luego aplicamos supresión de no-máximos: si dos picos están a menos de
 * `distanciaMinHz`, nos quedamos con el más alto. Esa distancia es 4 bins del
 * tramo original, o sea la mitad del lóbulo principal de la ventana.
 */
export function detectarPicos(espectro, opciones = {}) {
  const { dB, df, dfTramo, fs } = espectro;
  const umbralRelativo = opciones.umbralDB ?? -70;
  const fMin = opciones.fMin ?? 10;
  const fMax = opciones.fMax ?? fs / 2;
  const distanciaMinHz = opciones.distanciaMinHz ?? 4 * dfTramo;
  const maxPicos = opciones.maxPicos ?? 400;

  const kMin = Math.max(1, Math.ceil(fMin / df));
  const kMax = Math.min(dB.length - 2, Math.floor(fMax / df));
  const piso = nivelMedioDB(espectro);

  let maxDB = -Infinity;
  for (let k = kMin; k <= kMax; k++) if (dB[k] > maxDB) maxDB = dB[k];
  const umbral = Math.max(maxDB + umbralRelativo, piso + 10);

  const candidatos = [];
  for (let k = kMin; k <= kMax; k++) {
    if (dB[k] >= umbral && dB[k] > dB[k - 1] && dB[k] >= dB[k + 1]) {
      candidatos.push({ freq: k * df, dB: dB[k] });
    }
  }
  candidatos.sort((a, b) => b.dB - a.dB);

  // Supresión de no-máximos (greedy): de más alto a más bajo, aceptamos si no
  // está cerca de un pico ya aceptado.
  const aceptados = [];
  for (const c of candidatos) {
    if (aceptados.length >= maxPicos) break;
    if (aceptados.every((a) => Math.abs(a.freq - c.freq) >= distanciaMinHz)) {
      aceptados.push(c);
    }
  }
  aceptados.sort((a, b) => a.freq - b.freq);
  return { picos: aceptados, piso, maxDB };
}

// Primer índice de la lista ordenada (por freq) cuya frecuencia es >= valor. Búsqueda binaria.
function primerIndiceDesde(picos, valor) {
  let lo = 0;
  let hi = picos.length;
  while (lo < hi) {
    const medio = (lo + hi) >> 1;
    if (picos[medio].freq < valor) lo = medio + 1;
    else hi = medio;
  }
  return lo;
}

/**
 * Pico más alto (en dB) dentro de la ventana [centro - radio, centro + radio].
 * Devuelve null si no hay ningún pico ahí.
 */
export function picoMasAltoEnVentana(picos, centro, radio) {
  let mejor = null;
  for (let i = primerIndiceDesde(picos, centro - radio); i < picos.length; i++) {
    const p = picos[i];
    if (p.freq > centro + radio) break;
    if (mejor === null || p.dB > mejor.dB) mejor = p;
  }
  return mejor;
}

/**
 * Autocorrelación de la señal por la DFT (teorema de Wiener-Khinchin):
 *   r[τ] = Σ x[n]·x[n+τ]  =  IDFT( |X(k)|² )
 * Para no obtener correlación circular, rellenamos con ceros hasta ≥ 2N.
 * Devolvemos r normalizada por r[0] (así r[0] = 1).
 */
export function autocorrelacion(x) {
  const N = x.length;
  const M = siguientePotenciaDe2(2 * N);
  const re = new Float64Array(M);
  const im = new Float64Array(M);
  re.set(x);
  fft(re, im);
  for (let k = 0; k < M; k++) {
    re[k] = re[k] * re[k] + im[k] * im[k];
    im[k] = 0;
  }
  // |X|² es real y simétrico: aplicar la DFT otra vez da la autocorrelación (salvo factor M).
  fft(re, im);
  const r = new Float64Array(N);
  for (let tau = 0; tau < N; tau++) r[tau] = re[tau] / re[0];
  return r;
}

/**
 * Estimación gruesa de f0 por autocorrelación.
 * Una señal periódica con período T se parece a sí misma cuando la desplazamos
 * T muestras: r[τ] tiene máximos en τ = T, 2T, 3T... La fundamental es el
 * período más corto con correlación alta: tomamos el PRIMER máximo local cuyo
 * valor es ≥ 0.9 del máximo del rango. Así no confundimos f0 con 2·f0, cuya
 * correlación es mucho menor porque sólo acierta en los armónicos pares.
 * La resolución es de 1 muestra, así que esta f0 es "gruesa": la refinamos después.
 */
export function estimarF0PorAutocorrelacion(x, fs, opciones = {}) {
  const fMin = opciones.fMin ?? 20;
  const fMax = opciones.fMax ?? 1500;
  const r = autocorrelacion(x);
  const tauMin = Math.max(2, Math.floor(fs / fMax));
  const tauMax = Math.min(r.length - 2, Math.ceil(fs / fMin));

  let rMax = -Infinity;
  for (let tau = tauMin; tau <= tauMax; tau++) if (r[tau] > rMax) rMax = r[tau];
  for (let tau = tauMin; tau <= tauMax; tau++) {
    const esMaximo = r[tau] >= r[tau - 1] && r[tau] >= r[tau + 1];
    if (esMaximo && r[tau] >= 0.9 * rMax) {
      return { f0: fs / tau, tau, correlacion: r[tau] };
    }
  }
  return null;
}

/**
 * Refinamiento de f0 con el espectro: buscamos el pico más alto de la DFT
 * dentro de ±1 % de la estimación gruesa. Como el paso del espectro es 0.021 Hz,
 * esto da la frecuencia con precisión de la DFT, mucho mejor que el paso de la
 * autocorrelación (1 muestra). Si no hay pico en ese entorno, devolvemos la gruesa.
 */
export function refinarF0ConPicos(picos, f0Grueso) {
  const pico = picoMasAltoEnVentana(picos, f0Grueso, 0.01 * f0Grueso);
  return pico ? pico.freq : f0Grueso;
}

/**
 * Búsqueda de armónicos k = 1, 2, 3, ...
 * Para cada k predecimos f_pred = k·f0·√(1+B·k²) y buscamos el pico más alto
 * en una ventana alrededor. La ventana crece con k porque la inarmonía y el
 * error de la estimación crecen con k:  tol = min(0.4·f0, f_pred·(0.2% + 0.05%·k)).
 * El límite 0.4·f0 evita que la ventana invada al armónico vecino.
 * Se detiene al encontrar MAX_FALTAS_SEGUIDAS k sin pico, o al llegar a fs/2.
 */
export function buscarArmonicos(picos, f0, B, opciones) {
  const { fs, piso } = opciones;
  const presentes = [];
  let faltasSeguidas = 0;

  for (let k = 1; k <= K_MAX; k++) {
    const fPred = k * f0 * Math.sqrt(1 + B * k * k);
    if (fPred >= fs / 2) break;
    const tolerancia = Math.min(0.4 * f0, fPred * (0.002 + 0.0005 * k));
    const pico = picoMasAltoEnVentana(picos, fPred, tolerancia);
    if (pico && pico.dB >= piso + EXCESO_SIGNIFICATIVO_DB) {
      presentes.push({ k, fPred, fMed: pico.freq, dB: pico.dB });
      faltasSeguidas = 0;
    } else {
      faltasSeguidas++;
      if (faltasSeguidas >= MAX_FALTAS_SEGUIDAS) break;
    }
  }
  return presentes;
}

/**
 * Ajuste del modelo de inarmonía por mínimos cuadrados (álgebra lineal).
 * Modelo: f_k = k·f0·√(1+B·k²). Elevamos al cuadrado y dividimos por k²:
 *   (f_k / k)² = f0² + f0²·B·k²
 * Es una recta y = a + b·x con x = k², a = f0², b = f0²·B. Los mínimos
 * cuadrados resuelven el sistema sobredeterminado (muchos armónicos, dos
 * incógnitas) minimizando la suma de residuos al cuadrado.
 * R² mide qué tan bien la recta explica los datos (1 = perfecto).
 */
export function ajustarB(puntos) {
  const n = puntos.length;
  if (n < 2) return null;
  const xs = puntos.map((p) => p.k * p.k);
  const ys = puntos.map((p) => (p.f / p.k) ** 2);
  const xMedia = xs.reduce((a, b) => a + b, 0) / n;
  const yMedia = ys.reduce((a, b) => a + b, 0) / n;

  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - xMedia) ** 2;
    sxy += (xs[i] - xMedia) * (ys[i] - yMedia);
  }
  if (sxx === 0) return null;

  const pendiente = sxy / sxx;
  const ordenada = yMedia - pendiente * xMedia;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const ajustado = ordenada + pendiente * xs[i];
    ssRes += (ys[i] - ajustado) ** 2;
    ssTot += (ys[i] - yMedia) ** 2;
  }
  return {
    f0: Math.sqrt(ordenada),
    B: pendiente / ordenada,
    R2: ssTot === 0 ? 1 : 1 - ssRes / ssTot,
    n,
  };
}

/**
 * Análisis de armónicos (cuerda). Alterna dos pasos hasta que converge:
 *   a) buscar armónicos con el f0 y B actuales (al principio B = 0)
 *   b) reajustar f0 y B con los armónicos encontrados
 * Al empezar con B = 0 los armónicos altos quedan fuera de la ventana, pero con
 * el ajuste de los primeros se corrige y encuentra más. Cuatro vueltas bastan.
 */
export function analizarArmonicos(picos, f0Inicial, opciones) {
  const { fs, piso } = opciones;
  let f0 = f0Inicial;
  let B = 0;
  let presentes = [];
  let ajuste = null;

  for (let vuelta = 0; vuelta < 4; vuelta++) {
    presentes = buscarArmonicos(picos, f0, B, { fs, piso });
    const nuevo = ajustarB(presentes.map((p) => ({ k: p.k, f: p.fMed })));
    if (!nuevo) break;
    const cambio = Math.abs(nuevo.f0 - f0);
    f0 = nuevo.f0;
    B = nuevo.B;
    ajuste = nuevo;
    if (vuelta > 0 && cambio < 1e-6) break;
  }

  // Referencia para la amplitud relativa: el armónico 1 (si no está, el más alto).
  const ref = presentes.find((p) => p.k === 1) ?? presentes.reduce((a, b) => (b.dB > a.dB ? b : a), presentes[0]);
  const refDB = ref ? ref.dB : 0;

  const armonicos = presentes.map((p) => {
    const ideal = p.k * f0;
    const modelo = p.k * f0 * Math.sqrt(1 + B * p.k * p.k);
    return {
      k: p.k,
      frecuenciaHz: p.fMed,
      amplitudDB: p.dB,
      amplitudRelDB: p.dB - refDB,
      desvioHz: p.fMed - ideal,
      desvioCents: 1200 * Math.log2(p.fMed / ideal),
      desvioModeloCents: 1200 * Math.log2(p.fMed / modelo),
    };
  });

  return {
    f0: ajuste ? ajuste.f0 : f0Inicial,
    B: ajuste ? ajuste.B : 0,
    R2: ajuste ? ajuste.R2 : null,
    armonicos,
  };
}

/**
 * Modo vibráfono: no forzamos k·f0. Tomamos los picos más fuertes (dentro de
 * 50 dB del máximo y por encima del nivel medio + 15 dB), hasta 12 parciales.
 * La fundamental es el parcial de frecuencia más baja. Para cada parcial damos
 * la razón f/f0 y la comparamos con la razón teórica más cercana (1, 4, 10).
 * Las barras de vibráfono no son armónicas: sus modos se aproximan a 1 : 4 : 10.
 */
export function analizarParciales(picos, piso, maxDB) {
  const candidatos = picos.filter((p) => p.dB >= piso + EXCESO_SIGNIFICATIVO_DB && p.dB >= maxDB - 50);
  // Un pico que tiene otro más fuerte a menos de 2 Hz es lóbulo lateral de la ventana,
  // no un parcial: los parciales de un vibráfono están separados por cientos de Hz.
  const fuertes = candidatos
    .filter((p) => !candidatos.some((q) => q.dB > p.dB && Math.abs(q.freq - p.freq) < 2))
    .sort((a, b) => b.dB - a.dB)
    .slice(0, 12)
    .sort((a, b) => a.freq - b.freq);
  if (fuertes.length === 0) return { f0: null, parciales: [] };

  const f0 = fuertes[0].freq;
  const teoricas = [1, 4, 10];
  const parciales = fuertes.map((p, i) => {
    const razon = p.freq / f0;
    let mejor = teoricas[0];
    for (const t of teoricas) if (Math.abs(razon - t) < Math.abs(razon - mejor)) mejor = t;
    const tieneModelo = Math.abs(razon - mejor) / mejor < 0.15;
    return {
      n: i + 1,
      frecuenciaHz: p.freq,
      amplitudDB: p.dB,
      amplitudRelDB: p.dB - fuertes[0].dB,
      razon,
      razonTeorica: tieneModelo ? mejor : null,
      diferenciaRazon: tieneModelo ? razon - mejor : null,
    };
  });
  return { f0, parciales };
}

/**
 * Nota musical y afinación (temperamento igual, A4 = 440 Hz).
 * n = round(69 + 12·log₂(f0/440)): número MIDI de la nota más cercana (A4 = 69).
 * f_ideal = 440·2^((n-69)/12): frecuencia exacta de esa nota en temperamento igual.
 * Afinación en Hz = f0 - f_ideal; en cents = 1200·log₂(f0/f_ideal).
 * El cent es 1/100 de semitono: el oído distingue ~5 cents.
 */
export function nombreNota(f0) {
  const n = Math.round(69 + 12 * Math.log2(f0 / 440));
  const fIdeal = 440 * 2 ** ((n - 69) / 12);
  const i = ((n % 12) + 12) % 12;
  const octava = Math.floor(n / 12) - 1;
  return {
    midi: n,
    nombreES: `${NOMBRES_ES[i]}${octava}`,
    nombreEN: `${NOMBRES_EN[i]}${octava}`,
    fIdeal,
    afinacionHz: f0 - fIdeal,
    afinacionCents: 1200 * Math.log2(f0 / fIdeal),
  };
}
