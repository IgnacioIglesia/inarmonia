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
// Rango de fundamentales que soporta el análisis: de A0 (27,5 Hz) a C8 (4186 Hz), el del piano.
export const RANGO_F0 = { minHz: 27.5, maxHz: 4186.01 };
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
  const fMax = opciones.fMax ?? 1.1 * RANGO_F0.maxHz;
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
 * f0 gruesa por el espectro: el pico más grave entre los que están a menos de
 * `margenDB` del más fuerte. Es más confiable que la autocorrelación cuando hay
 * inarmonía: la señal deja de ser exactamente periódica y la autocorrelación
 * puede elegir un lag espurio. Devuelve null si no hay ningún pico candidato.
 */
export function estimarF0PorEspectro(picos, maxDB, margenDB = 30) {
  const candidatos = picos.filter((p) => p.dB >= maxDB - margenDB && p.freq >= RANGO_F0.minHz * 0.8);
  return candidatos.length ? candidatos[0].freq : null;
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
 * Pico significativo (supera el nivel medio en 15 dB) dentro de `tolerancia`
 * de la frecuencia esperada. Devuelve el pico o null.
 */
function buscarArmonico(picos, esperada, tolerancia, piso) {
  const pico = picoMasAltoEnVentana(picos, esperada, tolerancia);
  return pico && pico.dB >= piso + EXCESO_SIGNIFICATIVO_DB ? pico : null;
}

/** Frecuencia predicha por el modelo de cuerda rígida: f_k = k·f0·√(1 + B·k²). */
function frecuenciaPredicha(k, modelo) {
  return k * modelo.f0 * Math.sqrt(1 + modelo.B * k * k);
}

/** Desvío en cents de una frecuencia medida respecto de la predicha por el modelo. */
function centsRespectoDelModelo(fMedida, k, modelo) {
  return 1200 * Math.log2(fMedida / frecuenciaPredicha(k, modelo));
}

/**
 * Ajuste por mínimos cuadrados del modelo de inarmonía:
 *   f_k = k·f0·√(1 + B·k²)
 * Dividiendo por k²: f_k²/k² = f0² + f0²·B·k². Es una recta en x = k² con
 * ordenada f0² y pendiente f0²·B, así que el ajuste es cerrado (sin iterar).
 * Necesita al menos 3 armónicos. Devuelve { f0, B } o null.
 */
export function ajustarInarmonia(armonicos) {
  const n = armonicos.length;
  if (n < 3) return null;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const a of armonicos) {
    const x = a.k * a.k;
    const y = (a.fMedida * a.fMedida) / x;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const pendiente = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const ordenada = (sy - pendiente * sx) / n;
  if (!(ordenada > 0)) return null;
  return { f0: Math.sqrt(ordenada), B: pendiente / ordenada };
}

function mediana(valores) {
  const orden = [...valores].sort((a, b) => a - b);
  const mitad = orden.length >> 1;
  return orden.length % 2 ? orden[mitad] : (orden[mitad - 1] + orden[mitad]) / 2;
}

/**
 * Ajuste robusto: ajusta, descarta los armónicos que se alejan del modelo más de
 * 3 veces la mediana de los desvíos (más 10 cents) y reajusta con los que quedan.
 * Así un pico equivocado (un vecino del armónico) no tuerce f0 ni B.
 * Devuelve { modelo, usados }; el modelo es null si no hay datos suficientes.
 */
function ajustarRobusto(armonicos) {
  const inicial = ajustarInarmonia(armonicos);
  if (!inicial) return { modelo: null, usados: armonicos };
  const desvios = armonicos.map((a) => Math.abs(centsRespectoDelModelo(a.fMedida, a.k, inicial)));
  const limite = 3 * mediana(desvios) + 10;
  const usados = armonicos.filter((_, i) => desvios[i] <= limite);
  return { modelo: ajustarInarmonia(usados) ?? inicial, usados };
}

/**
 * Armónicos k = 1, 2, 3... presentes en el espectro, con un ajuste de inarmonía.
 * Seguimiento: cada armónico se busca donde predice el modelo ajustado con los
 * anteriores, en una ventana de 1 % (y al menos 4 bins). Así la búsqueda sigue
 * a la inarmonía sin cortarse, y no entra el vecino de otro armónico.
 * Al final, ajuste robusto (f0 y B) sobre los armónicos aceptados. Los que no
 * aparecen, o quedan como atípicos, se listan en noDetectados.
 * El reporte usa f0 y B del ajuste final; cada desvío es medido − k·f0.
 */
export function analizarArmonicos(picos, f0Grueso, opciones) {
  const { fs, piso, dfTramo } = opciones;

  const aceptados = [];
  const noDetectados = [];
  let modelo = { f0: f0Grueso, B: 0 };
  for (let k = 1; k <= K_MAX; k++) {
    const predicha = frecuenciaPredicha(k, modelo);
    if (predicha >= fs / 2) break;
    const tolerancia = Math.min(0.25 * f0Grueso, Math.max(4 * dfTramo, 0.01 * predicha));
    const pico = buscarArmonico(picos, predicha, tolerancia, piso);
    if (pico) {
      aceptados.push({ k, fMedida: pico.freq, dB: pico.dB });
      modelo = ajustarInarmonia(aceptados) ?? { f0: aceptados[0].fMedida, B: 0 };
    } else {
      noDetectados.push(k);
    }
  }

  const { modelo: ajuste, usados } = ajustarRobusto(aceptados);
  const usadosK = new Set(usados.map((u) => u.k));
  for (const p of aceptados) if (!usadosK.has(p.k)) noDetectados.push(p.k);
  // Sólo son huecos los k por debajo del armónico más alto detectado: los de orden
  // mayor caen bajo el ruido y no se reportan como faltantes.
  const kMasAlto = Math.max(0, ...usados.map((u) => u.k));
  const huecos = noDetectados.filter((k) => k < kMasAlto).sort((a, b) => a - b);

  // Sin ajuste (menos de 3 armónicos), f0 es el armónico 1 medido, o la gruesa.
  const primero = usados.find((p) => p.k === 1);
  const f0 = ajuste ? ajuste.f0 : primero ? primero.fMedida : f0Grueso;
  const B = ajuste ? ajuste.B : null;

  // Amplitud relativa respecto del armónico 1 (si no está, respecto del más alto).
  const ref = primero ?? usados.reduce((a, b) => (b.dB > a.dB ? b : a), usados[0]);
  const refDB = ref ? ref.dB : 0;

  const armonicos = usados.map((p) => {
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

  return { f0, B, armonicos, noDetectados: huecos };
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
