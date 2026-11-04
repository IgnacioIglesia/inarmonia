// pipeline.js
// ------------------------------------------------------------------
// Orquesta el procesamiento, en el orden en que se ejecuta:
//   1) potencia media por ventanas → onset → tramo sostenido
//   2) análisis del ruido previo al ataque (zumbido de 50 Hz)
//   3) f0 gruesa por autocorrelación, para decidir qué notches aplicar
//   4) filtrado de los armónicos de 50 Hz (notch) en el tiempo
//   5) espectro con zero-padding del tramo filtrado → picos → armónicos
// Vive aparte de main.js (que toca el DOM) para poder probarlo sin navegador.
// ------------------------------------------------------------------

import { espectroDeTramo } from './fft.js';
import { envolventeRMS, detectarOnset, elegirTramo, segmentoPrevioAlOnset } from './segmentacion.js';
import {
  disenarNotch,
  aplicarFiltros,
  respuestaFrecuenciaDB,
  elegirNotches,
  analizarZumbido,
} from './filtros.js';
import {
  detectarPicos,
  estimarF0PorAutocorrelacion,
  refinarF0ConPicos,
  analizarArmonicos,
  analizarParciales,
  nombreNota,
} from './armonicos.js';

// Valores fijos del análisis (se explican en la defensa).
const CONFIG = {
  inicioMs: 150,        // el tramo arranca 150 ms después del onset (saltea el golpe)
  duracionMaxS: 4,      // y dura como máximo 4 s
  umbralPicosDB: -70,   // picos hasta 70 dB debajo del máximo
  Q_NOTCH: 30,          // ancho del notch: ~1.7 Hz
};

// Escala logarítmica de frecuencias para graficar la respuesta del filtro.
function frecuenciasLog(fMin, fMax, n) {
  const salida = new Float64Array(n);
  const a = Math.log10(fMin);
  const b = Math.log10(fMax);
  for (let i = 0; i < n; i++) salida[i] = 10 ** (a + ((b - a) * i) / (n - 1));
  return salida;
}

/**
 * Analiza una nota.
 * x: señal preparada (mono, sin DC, normalizada) como Float64Array.
 * fs: frecuencia de muestreo en Hz.
 * instrumento: 'cuerda' o 'vibrafono'.
 */
export function analizarNota(x, fs, instrumento = 'cuerda') {
  const advertencias = [];

  // 1) Segmentación.
  const envolvente = envolventeRMS(x, fs, 10);
  const onsetIdx = detectarOnset(envolvente.envDB);
  const onsetMuestra = onsetIdx * envolvente.L;
  const tramo = elegirTramo(envolvente, onsetIdx, fs, {
    inicioMs: CONFIG.inicioMs,
    duracionMaxS: CONFIG.duracionMaxS,
  });
  if (tramo.duracionS < 0.5) {
    advertencias.push(`El tramo sostenido es muy corto (${tramo.duracionS.toFixed(2)} s).`);
  }
  const tramoCrudo = x.slice(tramo.inicio, tramo.fin);

  // 2) Ruido: el segundo previo al ataque.
  const segmentoRuido = segmentoPrevioAlOnset(x, fs, onsetMuestra);
  const ruido = segmentoRuido
    ? analizarZumbido(segmentoRuido, fs)
    : { detectado: false, frecuencias: [], espectro: null };
  if (!segmentoRuido) {
    advertencias.push('No hay ruido previo al ataque: no se evalúa el zumbido.');
  }

  // 3) f0 gruesa sobre el tramo crudo: decide qué notches no tocan la nota.
  const espCrudo = espectroDeTramo(tramoCrudo, fs);
  const picosCrudos = detectarPicos(espCrudo, { umbralDB: CONFIG.umbralPicosDB });
  const acCruda = estimarF0PorAutocorrelacion(tramoCrudo, fs);
  const f0Grueso = acCruda ? refinarF0ConPicos(picosCrudos.picos, acCruda.f0) : null;

  // 4) Filtrado: un notch por cada armónico de 50 Hz que apareció en el ruido.
  const zumbidoNominal = [...new Set(ruido.frecuencias.map((z) => Math.round(z.f / 50) * 50))];
  let aplicados = zumbidoNominal;
  const omitidos = [];
  if (zumbidoNominal.length > 0 && f0Grueso !== null) {
    const decision = elegirNotches(zumbidoNominal, f0Grueso, 3, fs);
    aplicados = decision.aplicar;
    omitidos.push(...decision.omitir);
  }
  for (const o of omitidos) {
    advertencias.push(`No se filtró el zumbido en ${o.f} Hz: ${o.motivo}.`);
  }
  const notches = aplicados.map((f) => disenarNotch(f, fs, CONFIG.Q_NOTCH));
  const xFiltrada = aplicarFiltros(x, notches);
  const tramoFiltrado = xFiltrada.slice(tramo.inicio, tramo.fin);

  // 5) Análisis de alta resolución del tramo filtrado.
  const espFiltrado = espectroDeTramo(tramoFiltrado, fs);
  const picos = detectarPicos(espFiltrado, { umbralDB: CONFIG.umbralPicosDB });

  const frecuencias = frecuenciasLog(5, fs / 2, 2000);
  const resultado = {
    fs,
    duracionS: x.length / fs,
    senal: { x, envolvente, onsetS: onsetMuestra / fs, tramo },
    ruido: {
      disponible: segmentoRuido !== null,
      espectro: ruido.espectro,
      zumbido: ruido.frecuencias,
      zumbidoDetectado: ruido.detectado,
    },
    filtros: {
      notches: { aplicados, omitidos },
      respuesta: {
        frecuencias,
        dBTotal: respuestaFrecuenciaDB(notches, fs, frecuencias),
      },
    },
    espectros: { antes: espCrudo, despues: espFiltrado },
    picos: picos.picos,
    modo: instrumento,
    f0: null,
    nota: null,
    armonicos: [],
    parciales: [],
    advertencias,
  };

  if (instrumento === 'vibrafono') {
    const r = analizarParciales(picos.picos, picos.piso, picos.maxDB);
    resultado.parciales = r.parciales;
    resultado.f0 = r.f0;
    if (r.f0 === null) advertencias.push('No se encontraron parciales significativos.');
  } else {
    const acFiltrada = estimarF0PorAutocorrelacion(tramoFiltrado, fs);
    if (acFiltrada === null) {
      advertencias.push('No se encontró una fundamental.');
      return resultado;
    }
    const f0Inicial = refinarF0ConPicos(picos.picos, acFiltrada.f0);
    const r = analizarArmonicos(picos.picos, f0Inicial, { fs, piso: picos.piso });
    resultado.f0 = r.f0;
    resultado.armonicos = r.armonicos;
    if (r.armonicos.length < 5) {
      advertencias.push(`Sólo se detectaron ${r.armonicos.length} armónicos.`);
    }
  }

  if (resultado.f0 !== null) resultado.nota = nombreNota(resultado.f0);
  return resultado;
}
