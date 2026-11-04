// armonicos.js
// ------------------------------------------------------------------
// Análisis del espectro de la nota:
//  - picos del espectro (la DFT con zero-padding da el paso fino de frecuencias)
//  - fundamental por autocorrelación, refinada con el espectro
//  - armónicos: frecuencia, amplitud relativa y desviación respecto de k·f0
//  - nota musical y afinación (temperamento igual, A4 = 440 Hz)
//  - modo vibráfono: parciales con su razón respecto de la fundamental
// ------------------------------------------------------------------

import { fft, siguientePotenciaDe2 } from './fft.js';

// Un pico es "significativo" si supera el nivel medio del espectro en 15 dB.
// Dentro de una ventana de búsqueda hay muchos bins de ruido; su máximo queda unos
// 8 dB por encima del nivel medio.
const EXCESO_SIGNIFICATIVO_DB = 15;
// La búsqueda de armónicos se detiene tras 3 k seguidos sin pico significativo.
const MAX_FALTAS_SEGUIDAS = 3;
// Límite de armónicos a buscar.
const K_MAX = 200;

const NOMBRES_ES = ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];
const NOMBRES_EN = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Nivel medio del espectro en dB: promedio aritmético de todos los bins.
 * Es la referencia para decidir si un pico es significativo. Usamos el promedio
 * de dB porque los pocos picos fuertes casi no lo desplazan.
 */
export function nivelMedioDB(espectro) {
  const dB = espectro.dB;
  let suma = 0;
  for (let k = 0; k < dB.length; k++) suma += dB[k];
  return suma / dB.length;
}

/**
 * Picos del espectro.
 * Un pico es un máximo local que está a menos de `umbralDB` (−70 dB) del máximo
 * global y supera el nivel medio en 10 dB. Su frecuencia es k·Δf, con
 * Δf = fs/N_FFT (0.021 Hz con zero-padding a 2^21).
 * Eliminamos duplicados: si dos picos están a menos de `distanciaMinHz`
 * (4 bins del tramo, unos 1 Hz), nos quedamos con el más alto.
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

/** Pico más alto dentro de la ventana [centro - radio, centro + radio]; null si no hay ninguno. */
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
 * Autocorrelación por la DFT (teorema de Wiener-Khinchin):
 *   r[τ] = Σ x[n]·x[n+τ] = IDFT(|X(k)|²)
 * Rellenamos con ceros hasta ≥ 2N para no tener correlación circular.
 * Devuelve r normalizada, con r[0] = 1.
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
  // |X|² es real y simétrico: otra DFT da la autocorrelación, salvo el factor M.
  fft(re, im);
  const r = new Float64Array(N);
  for (let tau = 0; tau < N; tau++) r[tau] = re[tau] / re[0];
  return r;
}

/**
 * f0 gruesa por autocorrelación.
 * La señal periódica con período T se parece a sí misma al desplazarla T:
 * r[τ] tiene máximos en τ = T, 2T, 3T... Tomamos el PRIMER máximo local con
 * valor ≥ 0.9 del máximo del rango, para no confundir f0 con 2·f0.
 * La resolución es de una muestra; por eso después la refinamos con el espectro.
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
 * Refina la f0 gruesa con el espectro: pico más alto dentro de ±1 %.
 * Con paso de 0.021 Hz, esto da la frecuencia con mucha más precisión que la autocorrelación.
 */
export function refinarF0ConPicos(picos, f0Grueso) {
  const pico = picoMasAltoEnVentana(picos, f0Grueso, 0.01 * f0Grueso);
  return pico ? pico.freq : f0Grueso;
}

/**
 * Armónicos k = 1, 2, 3...
 * Para cada k esperamos el pico cerca de k·f0. La inarmonía desplaza los armónicos
 * altos en proporción a k³ (desvío ≈ B·k³·f0/2), así que la tolerancia crece con k²:
 *   tolerancia = min(0.35·f0, 0.5 %·k²·f0)
 * El límite 0.35·f0 evita que la ventana capture al armónico vecino (está a f0):
 * si el desvío de un armónico supera ~0.65·f0, la búsqueda se corta y no se inventa un armónico.
 * Un armónico es significativo si su pico supera el nivel medio en 15 dB.
 * La búsqueda se corta tras 3 k seguidos sin pico significativo, o al llegar a fs/2.
 */
export function analizarArmonicos(picos, f0Grueso, opciones) {
  const { fs, piso } = opciones;
  const presentes = [];
  let faltasSeguidas = 0;

  for (let k = 1; k <= K_MAX; k++) {
    const fIdeal = k * f0Grueso;
    if (fIdeal >= fs / 2) break;
    const tolerancia = Math.min(0.35 * f0Grueso, 0.005 * k * k * f0Grueso);
    const pico = picoMasAltoEnVentana(picos, fIdeal, tolerancia);
    if (pico && pico.dB >= piso + EXCESO_SIGNIFICATIVO_DB) {
      presentes.push({ k, fIdeal, fMedida: pico.freq, dB: pico.dB });
      faltasSeguidas = 0;
    } else {
      faltasSeguidas++;
      if (faltasSeguidas >= MAX_FALTAS_SEGUIDAS) break;
    }
  }

  // La fundamental medida es la del armónico 1 (si está); si no, la gruesa.
  const primero = presentes.find((p) => p.k === 1);
  const f0 = primero ? primero.fMedida : f0Grueso;

  // Amplitud relativa respecto del armónico 1 (si no está, respecto del más alto).
  const ref = primero ?? presentes.reduce((a, b) => (b.dB > a.dB ? b : a), presentes[0]);
  const refDB = ref ? ref.dB : 0;

  const armonicos = presentes.map((p) => {
    const ideal = p.k * f0;
    return {
      k: p.k,
      frecuenciaHz: p.fMedida,
      amplitudDB: p.dB,
      amplitudRelDB: p.dB - refDB,
      desvioHz: p.fMedida - ideal,
      desvioCents: 1200 * Math.log2(p.fMedida / ideal),
    };
  });

  return { f0, armonicos };
}

/**
 * Modo vibráfono: no se fuerza k·f0. Tomamos hasta 12 picos fuertes (dentro de
 * 50 dB del máximo y por encima del nivel medio + 15 dB), descartamos lóbulos
 * laterales (un pico con otro más fuerte a menos de 2 Hz) y ordenamos por
 * frecuencia. La fundamental es el parcial más grave; cada parcial lleva su
 * razón f/f0.
 */
export function analizarParciales(picos, piso, maxDB) {
  const candidatos = picos.filter((p) => p.dB >= piso + EXCESO_SIGNIFICATIVO_DB && p.dB >= maxDB - 50);
  const fuertes = candidatos
    .filter((p) => !candidatos.some((q) => q.dB > p.dB && Math.abs(q.freq - p.freq) < 2))
    .sort((a, b) => b.dB - a.dB)
    .slice(0, 12)
    .sort((a, b) => a.freq - b.freq);
  if (fuertes.length === 0) return { f0: null, parciales: [] };

  const f0 = fuertes[0].freq;
  const parciales = fuertes.map((p, i) => ({
    n: i + 1,
    frecuenciaHz: p.freq,
    amplitudRelDB: p.dB - fuertes[0].dB,
    razon: p.freq / f0,
  }));
  return { f0, parciales };
}

/**
 * Nota musical y afinación (temperamento igual, A4 = 440 Hz).
 * n = round(69 + 12·log₂(f0/440)): número MIDI de la nota más cercana.
 * f_ideal = 440·2^((n−69)/12). Afinación en Hz = f0 − f_ideal;
 * en cents = 1200·log₂(f0/f_ideal). El cent es 1/100 de semitono.
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
