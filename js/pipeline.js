// pipeline.js
// ------------------------------------------------------------------
// Orquesta todo el procesamiento, en el orden en que lo explicamos en la defensa:
//   1) potencia media por ventanas → onset → tramo sostenido
//   2) análisis del ruido previo (zumbido de 50 Hz)
//   3) f0 gruesa por autocorrelación (sobre el tramo crudo) para fijar los filtros
//   4) filtrado: Butterworth bilineal + notch, en fase cero (DFT)
//   5) espectro con zero-padding del tramo filtrado → picos → armónicos
// Vive aparte de main.js (que toca el DOM) para que test/test.html use
// exactamente el mismo código que la interfaz.
// ------------------------------------------------------------------

import { espectroDeTramo } from './fft.js';
import { envolventeRMS, detectarOnset, elegirTramo, segmentoPrevioAlOnset } from './segmentacion.js';
import {
  disenarPasaAltosButterworth,
  disenarNotch,
  filtrarFaseCero,
  respuestaFrecuenciaDB,
  frecuenciasDeZumbido,
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

// Valores por defecto de la interfaz (ver RESUMEN.md para la justificación de cada uno).
export const OPCIONES_POR_DEFECTO = {
  instrumento: 'cuerda',        // 'cuerda' (piano, guitarra) o 'vibrafono'
  ventana: 'hann',              // ventana de la DFT (Hann, del temario)
  fcHP: 20,                     // frecuencia de corte del pasa-altos, en Hz
  inicioMs: 150,                // el tramo arranca 150 ms después del onset
  duracionMaxS: 4,              // y dura como máximo 4 s
  umbralPicosDB: -70,           // picos hasta 70 dB debajo del máximo
  Q_NOTCH: 30,                  // Q de los notches de 50 Hz
  silencio: null,               // opcional: Float64Array con sólo ruido
};

// Escala logarítmica de frecuencias para graficar la respuesta de los filtros.
function frecuenciasLog(fMin, fMax, n) {
  const salida = new Float64Array(n);
  const a = Math.log10(fMin);
  const b = Math.log10(fMax);
  for (let i = 0; i < n; i++) salida[i] = 10 ** (a + ((b - a) * i) / (n - 1));
  return salida;
}

/**
 * Analiza una nota.
 * x: señal ya preparada (mono, sin DC, normalizada) como Float64Array.
 * fs: frecuencia de muestreo en Hz.
 * Devuelve un objeto con todo lo que muestran la tabla y los gráficos.
 */
export function analizarNota(x, fs, opciones = {}) {
  const cfg = { ...OPCIONES_POR_DEFECTO, ...opciones };
  const advertencias = [];

  // 1) Segmentación: potencia por ventanas, onset y tramo sostenido.
  const envolvente = envolventeRMS(x, fs, 10);
  const onsetIdx = detectarOnset(envolvente.envDB);
  const onsetMuestra = onsetIdx * envolvente.L;
  const tramo = elegirTramo(envolvente, onsetIdx, fs, {
    inicioMs: cfg.inicioMs,
    duracionMaxS: cfg.duracionMaxS,
  });
  if (tramo.duracionS < 0.5) {
    advertencias.push(`El tramo sostenido es muy corto (${tramo.duracionS.toFixed(2)} s). La resolución en frecuencia será pobre.`);
  }
  const tramoCrudo = x.slice(tramo.inicio, tramo.fin);

  // 2) Ruido: del archivo de silencio si lo hay, si no del tramo previo al onset.
  const segmentoRuido = cfg.silencio ?? segmentoPrevioAlOnset(x, fs, onsetMuestra);
  const ruido = segmentoRuido
    ? analizarZumbido(segmentoRuido, fs)
    : { detectado: false, frecuencias: [], espectro: null };
  if (!segmentoRuido) {
    advertencias.push('No hay ruido previo disponible (la nota empieza casi al inicio). No se evalúa el zumbido.');
  }

  // 3) Fundamental gruesa sobre el tramo crudo: la autocorrelación da el período,
  // y el espectro refina la frecuencia. Hace falta antes de filtrar, para que la
  // frecuencia de corte del pasa-altos no supere 0.5·f0.
  const espCrudo = espectroDeTramo(tramoCrudo, fs, { ventana: cfg.ventana });
  const picosCrudos = detectarPicos(espCrudo, { umbralDB: cfg.umbralPicosDB });
  const acCruda = estimarF0PorAutocorrelacion(tramoCrudo, fs);
  const f0Grueso = acCruda ? refinarF0ConPicos(picosCrudos.picos, acCruda.f0) : null;

  // 4) Filtros: Butterworth bilineal + notch, aplicados en fase cero.
  let fc = cfg.fcHP;
  if (f0Grueso !== null && fc > 0.5 * f0Grueso) {
    fc = 0.5 * f0Grueso;
    advertencias.push(`La frecuencia de corte se bajó a ${fc.toFixed(1)} Hz para no superar 0.5·f0.`);
  }
  const hp = disenarPasaAltosButterworth(fc, fs, 4);

  // Zumbido: sólo los armónicos de 50 Hz que realmente aparecieron en el ruido.
  const zumbidoNominal = [...new Set(ruido.frecuencias.map((z) => Math.round(z.f / 50) * 50))];
  const omitidos = [];
  let aplicados = zumbidoNominal;
  if (zumbidoNominal.length > 0 && f0Grueso !== null) {
    const decision = elegirNotches(zumbidoNominal, f0Grueso, 3, fs);
    aplicados = decision.aplicar;
    omitidos.push(...decision.omitir);
  }
  const notches = aplicados.map((f) => disenarNotch(f, fs, cfg.Q_NOTCH));
  for (const o of omitidos) {
    advertencias.push(`No se filtró el zumbido en ${o.f} Hz: ${o.motivo}.`);
  }

  const secciones = [...hp.secciones, ...notches];
  const xFiltrada = filtrarFaseCero(x, secciones, fs);
  const tramoFiltrado = xFiltrada.slice(tramo.inicio, tramo.fin);

  // 5) Análisis de alta resolución del tramo filtrado.
  const espFiltrado = espectroDeTramo(tramoFiltrado, fs, { ventana: cfg.ventana });
  const picos = detectarPicos(espFiltrado, { umbralDB: cfg.umbralPicosDB });

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
      hp: { tipo: hp.tipo, orden: hp.orden, fc, Qs: hp.Qs },
      notches: { aplicados, Q: cfg.Q_NOTCH, omitidos },
      secciones,
      respuesta: {
        frecuencias: frecuenciasLog(5, fs / 2, 2000),
        dBTotal: null,
        dBHp: null,
      },
    },
    espectros: { antes: espCrudo, despues: espFiltrado },
    picos: picos.picos,
    f0Grueso,
    modo: cfg.instrumento,
    f0: null,
    B: null,
    R2: null,
    nota: null,
    armonicos: [],
    parciales: [],
    advertencias,
  };

  // Respuesta en frecuencia para el gráfico (se calcula al final, con las frecuencias guardadas).
  resultado.filtros.respuesta.dBTotal = respuestaFrecuenciaDB(secciones, fs, resultado.filtros.respuesta.frecuencias);
  resultado.filtros.respuesta.dBHp = respuestaFrecuenciaDB(hp.secciones, fs, resultado.filtros.respuesta.frecuencias);

  // Modo vibráfono: parciales sin forzar k·f0.
  if (cfg.instrumento === 'vibrafono') {
    const r = analizarParciales(picos.picos, picos.piso, picos.maxDB);
    resultado.parciales = r.parciales;
    resultado.f0 = r.f0;
    if (r.f0 === null) advertencias.push('No se encontraron parciales significativos.');
  } else {
    // f0 en el tramo filtrado: autocorrelación y refinamiento con el espectro.
    const acFiltrada = estimarF0PorAutocorrelacion(tramoFiltrado, fs);
    if (acFiltrada === null) {
      advertencias.push('No se encontró una fundamental. Revisá la señal.');
      return resultado;
    }
    const f0Inicial = refinarF0ConPicos(picos.picos, acFiltrada.f0);
    const r = analizarArmonicos(picos.picos, f0Inicial, { fs, piso: picos.piso });
    resultado.f0 = r.f0;
    resultado.B = r.B;
    resultado.R2 = r.R2;
    resultado.armonicos = r.armonicos;
    if (r.armonicos.length < 5) {
      advertencias.push(`Sólo se detectaron ${r.armonicos.length} armónicos: el resultado puede ser poco confiable.`);
    }
  }

  if (resultado.f0 !== null) resultado.nota = nombreNota(resultado.f0);
  return resultado;
}
