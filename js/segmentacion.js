// segmentacion.js
// ------------------------------------------------------------------
// Segmentación temporal de la nota:
//  1) envolvente RMS (cuánta energía hay en cada instante)
//  2) detección del onset (el momento del ataque)
//  3) elección del tramo sostenido sobre el que se hace el análisis
// ------------------------------------------------------------------
/**
 * Envolvente RMS en dB, calculada en ventanas consecutivas de ~10 ms.
 * RMS = raíz del promedio de x². Es una medida de energía, no de forma de onda:
 * sigue la "intensidad" de la nota aunque la onda oscile.
 * Usamos ventanas de 10 ms porque son lo bastante cortas para ver el ataque
 * (que dura unos pocos ms) y lo bastante largas para promediar varios ciclos
 * de notas medias. (Para notas muy graves, ~50 Hz, un ciclo dura 20 ms, así
 * que la envolvente tiene un pequeño rizado de ±3 dB; no afecta a los umbrales usados.)
 */
export function envolventeRMS(x, fs, ventanaMs = 10) {
  const L = Math.max(1, Math.round((fs * ventanaMs) / 1000));
  const cantidad = Math.floor(x.length / L);
  const envDB = new Float64Array(cantidad);
  const tiempos = new Float64Array(cantidad);
  for (let i = 0; i < cantidad; i++) {
    let suma = 0;
    for (let n = i * L; n < (i + 1) * L; n++) suma += x[n] * x[n];
    const rms = Math.sqrt(suma / L);
    envDB[i] = 20 * Math.log10(rms + 1e-12);
    tiempos[i] = ((i + 0.5) * L) / fs; // centro de la ventana, en segundos
  }
  return { envDB, tiempos, L, N: x.length };
}

/**
 * Onset: instante en que la energía sube de forma brusca desde el silencio.
 * Criterio: medimos cuántos dB sube la envolvente en 30 ms (3 ventanas de 10 ms)
 * en cada instante, y el onset es el punto donde esa subida es MÁXIMA.
 * Por qué "máxima subida" y no "cruzar un umbral": si el zumbido o el ruido de
 * fondo son fuertes, un umbral fijo se cruza sin que haya ninguna nota. Lo que
 * distingue al ataque es la pendiente: un golpe sube muchos dB en pocos ms,
 * mientras que el ruido y el zumbido fluctúan poco en 30 ms.
 * Si la subida máxima es menor a 6 dB, no hay ataque claro y devolvemos 0.
 * Devuelve el índice de la ventana de envolvente donde empieza la subida.
 */
export function detectarOnset(envDB, ventanasSalto = 3, minimoSubidaDB = 6) {
  let mejor = 0;
  let subidaMaxima = -Infinity;
  for (let i = ventanasSalto; i < envDB.length; i++) {
    const subida = envDB[i] - envDB[i - ventanasSalto];
    if (subida > subidaMaxima) {
      subidaMaxima = subida;
      mejor = i - ventanasSalto;
    }
  }
  return subidaMaxima >= minimoSubidaDB ? mejor : 0;
}

/**
 * Elige el tramo de análisis: [inicio, fin) en muestras.
 *  - Inicio: onset + inicioMs. Esperamos ~150 ms para saltear el ataque
 *    ruidoso (el golpe del martillo del piano o la púa de la guitarra
 *    contiene ruido que no es parte de la nota sostenida).
 *  - Fin: lo más largo posible, hasta duracionMaxS (4 s), o hasta que la
 *    envolvente caiga caidaDB (40 dB) respecto de su valor al inicio.
 * Cuanto más largo el tramo, más fina la resolución Δf = fs/N: por eso
 * queremos el tramo más largo que siga siendo "la misma nota".
 */
export function elegirTramo(envolvente, onsetIdx, fs, opciones = {}) {
  const inicioMs = opciones.inicioMs ?? 150;
  const duracionMaxS = opciones.duracionMaxS ?? 4;
  const caidaDB = opciones.caidaDB ?? 40;
  const { envDB, tiempos, L, N } = envolvente;

  const tOnset = tiempos[onsetIdx] ?? 0;
  const iInicio = Math.min(
    envDB.length - 1,
    Math.round((tOnset + inicioMs / 1000) * fs / L)
  );
  const nivelInicio = envDB[iInicio];

  const iMaxFin = Math.min(envDB.length, iInicio + Math.round((duracionMaxS * fs) / L));
  let iFin = iMaxFin;
  for (let i = iInicio; i < iMaxFin; i++) {
    if (envDB[i] < nivelInicio - caidaDB) {
      iFin = i;
      break;
    }
  }

  const inicio = iInicio * L;
  const fin = Math.min(N, iFin * L);
  return {
    inicio,
    fin,
    inicioS: inicio / fs,
    finS: fin / fs,
    duracionS: (fin - inicio) / fs,
    // true si el tramo terminó por caída de 40 dB (y no por límite de duración)
    terminoPorCaida: iFin < iMaxFin,
  };
}

/**
 * Segmento de "ruido previo": los ~1 s anteriores al onset, dejando 50 ms de
 * margen. Sirve para medir el ruido de fondo y el zumbido de red.
 * Si la grabación empieza ya con la nota (onset < 0.3 s), no hay ruido
 * previo disponible y devolvemos null.
 */
export function segmentoPrevioAlOnset(x, fs, onsetSample, duracionS = 1) {
  const fin = onsetSample - Math.round(0.05 * fs);
  if (fin < 0.3 * fs) return null;
  const inicio = Math.max(0, fin - Math.round(duracionS * fs));
  return x.slice(inicio, fin);
}
