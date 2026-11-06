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
  estimarF0PorEspectro,
  RANGO_F0,
} from './armonicos.js';

// f0 gruesa: por el espectro (robusto con inarmonía); si no hay picos, por autocorrelación.
function f0Gruesa(picos, tramo, fs) {
  const porEspectro = estimarF0PorEspectro(picos.picos, picos.maxDB);
  if (porEspectro !== null) return porEspectro;
  const ac = estimarF0PorAutocorrelacion(tramo, fs);
  return ac ? refinarF0ConPicos(picos.picos, ac.f0) : null;
}

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
  const f0Grueso = f0Gruesa(picosCrudos, tramoCrudo, fs);

  // 4) Filtrado: un notch por cada componente de zumbido medida en el ruido,
  // en la frecuencia medida (no redondeada a 50 Hz: la red puede desviarse).
  const zumbidoMedido = ruido.frecuencias.map((z) => z.f);
  let aplicados = zumbidoMedido;
  const omitidos = [];
  if (zumbidoMedido.length > 0 && f0Grueso !== null) {
    const decision = elegirNotches(zumbidoMedido, f0Grueso, 3, fs);
    aplicados = decision.aplicar;
    omitidos.push(...decision.omitir);
  }
  for (const o of omitidos) {
    advertencias.push(`No se filtró el zumbido en ${o.f.toFixed(1)} Hz: ${o.motivo}.`);
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
    B: null,
    noDetectados: [],
    parciales: [],
    advertencias,
  };

  if (instrumento === 'vibrafono') {
    const r = analizarParciales(picos.picos, picos.piso, picos.maxDB);
    resultado.parciales = r.parciales;
    resultado.f0 = r.f0;
    if (r.f0 === null) advertencias.push('No se encontraron parciales significativos.');
  } else {
    const f0Inicial = f0Gruesa(picos, tramoFiltrado, fs);
    if (f0Inicial === null) {
      advertencias.push('No se encontró una fundamental.');
      return resultado;
    }
    const r = analizarArmonicos(picos.picos, f0Inicial, {
      fs,
      piso: picos.piso,
      dfTramo: espFiltrado.dfTramo,
    });
    if (r.armonicos.length === 0) {
      advertencias.push('No se encontró una fundamental: ningún armónico supera el ruido.');
      return resultado;
    }
    resultado.f0 = r.f0;
    resultado.B = r.B;
    resultado.armonicos = r.armonicos;
    resultado.noDetectados = r.noDetectados;
    // Margen de 1 % para que A0 y C8 (medidos con un pelo de error) no den falsa alarma.
    if (r.f0 < RANGO_F0.minHz * 0.99 || r.f0 > RANGO_F0.maxHz * 1.01) {
      advertencias.push(
        `La fundamental (${r.f0.toFixed(1)} Hz) está fuera del rango analizado (${RANGO_F0.minHz} a ${RANGO_F0.maxHz.toFixed(0)} Hz, de A0 a C8).`
      );
    }
    if (r.armonicos.length < 5) {
      advertencias.push(`Sólo se detectaron ${r.armonicos.length} armónicos.`);
    }
    if (r.noDetectados.length > 0) {
      const lista = r.noDetectados.slice(0, 10).join(', ');
      const resto = r.noDetectados.length > 10 ? ` y ${r.noDetectados.length - 10} más` : '';
      advertencias.push(`No se detectaron armónicos por debajo del más alto medido: k = ${lista}${resto}.`);
    }
  }

  if (resultado.f0 !== null) resultado.nota = nombreNota(resultado.f0);
  return resultado;
}
