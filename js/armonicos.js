// armonicos.js
// ------------------------------------------------------------------
// Análisis del espectro de la nota:
//  - detección de picos y refinamiento sub-bin (interpolación parabólica)
//  - estimación de la fundamental f0 (suma armónica)
//  - búsqueda de armónicos con el modelo de inarmonía f_k = k·f0·√(1+B·k²)
//  - ajuste por mínimos cuadrados de f0 y B, con R²
//  - nota musical y afinación
//  - modo vibráfono: parciales no armónicos, comparados con 1 : 4 : 10
// ------------------------------------------------------------------

// Un pico es "significativo" si supera el piso de ruido (mediana del espectro) en 15 dB.
// Por qué 15 y no 10: dentro de una ventana de búsqueda hay cientos de bins de ruido,
// y el máximo de ese ruido queda ~8 dB por encima de la mediana. Con 10 dB aparecían
// armónicos falsos en las frecuencias altas.
const EXCESO_SIGNIFICATIVO_DB = 15;
// La búsqueda de armónicos se detiene tras 3 k seguidos sin pico significativo.
const MAX_FALTAS_SEGUIDAS = 3;
// Límite de armónicos a buscar (en la práctica se corta antes por fs/2 o por falta de energía).
const K_MAX = 200;

const NOMBRES_ES = ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];
const NOMBRES_EN = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Interpolación parabólica sobre 3 bins (k-1, k, k+1) del espectro en dB.
 * Idea: alrededor del máximo, la forma del lóbulo principal se parece a una
 * parábola. Ajustamos la parábola por esos 3 puntos y tomamos su vértice:
 *   δ = ½·(a - c) / (a - 2b + c)     (posición del vértice, en bins, |δ| ≤ ½)
 *   f = (k + δ)·Δf                    frecuencia refinada (sub-bin)
 *   A_dB = b - ¼·(a - c)·δ            amplitud refinada en dB
 * Por qué en dB y no en lineal: el lóbulo en dB es mucho más parecido a una
 * parábola, así que el error de la estimación es menor.
 */
export function interpolarPico(dB, k, df) {
  const a = dB[k - 1];
  const b = dB[k];
  const c = dB[k + 1];
  const denominador = a - 2 * b + c;
  let delta = denominador === 0 ? 0 : (0.5 * (a - c)) / denominador;
  delta = Math.max(-0.5, Math.min(0.5, delta));
  return {
    freq: (k + delta) * df,
    dB: b - 0.25 * (a - c) * delta,
  };
}

/** Mediana del espectro en dB (muestreada cada 8 bins para que sea rápida). */
export function medianaDB(espectro) {
  const muestras = [];
  for (let k = 0; k < espectro.dB.length; k += 8) muestras.push(espectro.dB[k]);
  muestras.sort((a, b) => a - b);
  return muestras[Math.floor(muestras.length / 2)];
}

/**
 * Detección de picos.
 * Un pico es un máximo local (más alto que sus vecinos) que además:
 *   1) está a menos de `umbralDB` (−70 dB) del máximo global, y
 *   2) supera el piso de ruido (mediana) en EXCESO_SIGNIFICATIVO_DB.
 * Luego aplicamos supresión de no-máximos: si dos picos están a menos de
 * `distanciaMinHz`, nos quedamos con el más alto. Esa distancia es 4 bins del
 * tramo original, o sea la mitad del lóbulo principal de la ventana: dos
 * componentes más cercanas que eso no se pueden separar de todos modos.
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
  const piso = medianaDB(espectro);

  let maxDB = -Infinity;
  for (let k = kMin; k <= kMax; k++) if (dB[k] > maxDB) maxDB = dB[k];
  const umbral = Math.max(maxDB + umbralRelativo, piso + EXCESO_SIGNIFICATIVO_DB);

  const candidatos = [];
  for (let k = kMin; k <= kMax; k++) {
    if (dB[k] >= umbral && dB[k] > dB[k - 1] && dB[k] >= dB[k + 1]) {
      candidatos.push(interpolarPico(dB, k, df));
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
 * Estimación de la fundamental por suma armónica.
 * Para cada frecuencia candidata f (todos los picos y sus submúltiplos p/n),
 * sumamos la amplitud lineal de los picos que caen cerca de k·f para k = 1..K.
 * La fundamental es la candidata con mayor suma.
 * Por qué funciona: el verdadero f0 "explica" más armónicos que sus
 * submúltiplos (f0/2 sólo acierta en los pares) y que sus múltiplos (2·f0
 * acierta en los pares de un conjunto que empieza en 2·f0). Así evitamos
 * elegir un armónico como fundamental. K = 10 limita la suma a la zona
 * donde están la mayoría de los parciales.
 */
export function estimarF0(picos, opciones = {}) {
  const fMin = opciones.fMin ?? 20;
  const fMax = opciones.fMax ?? 1500;
  const K = opciones.K ?? 10;

  const candidatos = [];
  for (const p of picos) {
    for (let n = 1; n <= 4; n++) {
      const f = p.freq / n;
      if (f >= fMin && f <= fMax) candidatos.push(f);
    }
  }

  let mejorF0 = null;
  let mejorSuma = -Infinity;
  for (const f of candidatos) {
    let suma = 0;
    for (let k = 1; k <= K; k++) {
      const centro = k * f;
      const p = picoMasAltoEnVentana(picos, centro, 0.15 * f);
      if (p) suma += 10 ** (p.dB / 20);
    }
    if (suma > mejorSuma) {
      mejorSuma = suma;
      mejorF0 = f;
    }
  }
  return mejorF0 === null ? null : { f0: mejorF0, suma: mejorSuma };
}

/**
 * Búsqueda de armónicos k = 1, 2, 3, ...
 * Para cada k predecimos f_pred = k·f0·√(1+B·k²) y buscamos el pico más alto
 * en una ventana alrededor. La ventana crece con k porque la inarmonía y el
 * error de la estimación crecen con k:  tol = min(0.4·f0, f_pred·(0.2% + 0.05%·k)).
 * Ventana más ancha = más chance de agarrar ruido: por eso es angosta en
 * términos relativos. El límite 0.4·f0 evita que la ventana invada al armónico vecino.
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
 * Ajuste del modelo de inarmonía por mínimos cuadrados.
 * Modelo: f_k = k·f0·√(1+B·k²). Elevamos al cuadrado y dividimos por k²:
 *   (f_k / k)² = f0² + f0²·B·k²
 * Eso es una RECTA en la variable x = k² con:
 *   ordenada al origen = f0²,  pendiente = f0²·B.
 * Entonces: f0 = √(ordenada), B = pendiente / ordenada.
 * R² indica qué tan bien la recta explica los datos (1 = perfecto).
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
 * Análisis de armónicos (cuerda y piano). Alterna dos pasos hasta que converge:
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
 * 50 dB del máximo y por encima del ruido), hasta 12 parciales. La
 * fundamental es el parcial de frecuencia más baja. Para cada parcial damos
 * la razón f/f0 y la comparamos con la razón teórica más cercana (1, 4, 10).
 * Las barras de vibráfono no son armónicas: sus modos se aproximan a 1 : 4 : 10.
 */
export function analizarParciales(picos, piso, maxDB) {
  const fuertes = picos
    .filter((p) => p.dB >= piso + EXCESO_SIGNIFICATIVO_DB && p.dB >= maxDB - 50)
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
 * n = round(69 + 12·log2(f0/440)): número MIDI de la nota más cercana (A4 = 69).
 * f_ideal = 440·2^((n-69)/12): frecuencia exacta de esa nota en temperamento igual.
 * Afinación en Hz = f0 - f_ideal; en cents = 1200·log2(f0/f_ideal).
 * El cent es 1/100 de semitono: el oído distingue ~5 cents, así que es la unidad
 * natural para hablar de afinación.
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
