// graficos.js
// ------------------------------------------------------------------
// Gráficos de la interfaz, hechos con Plotly.js (librería por CDN):
//   a) forma de onda, potencia por ventanas y tramo analizado
//   b) espectro del ruido previo, con el zumbido marcado
//   c) respuesta en frecuencia del filtro (notch)
//   d) espectro del tramo antes y después del filtrado
//   e) espectro con los armónicos medidos y los ideales k·f0
// ------------------------------------------------------------------

const COLORES = {
  senal: '#9aa4b2',
  envolvente: '#1f6feb',
  tramo: 'rgba(31, 111, 235, 0.12)',
  despues: '#1f6feb',
  armonicos: '#d1242f',
  ideal: '#1a7f37',
  filtro: '#bc4c00',
};

/**
 * Submuestreo para graficar: de cada bloque de puntos conservamos el máximo.
 * Así un espectro de un millón de puntos se dibuja con unos miles sin perder
 * los picos, que son lo que importa ver.
 */
export function diezmarMaximo(espectro, fMin, fMax, maxPuntos = 6000) {
  const { dB, df } = espectro;
  const kMin = Math.max(0, Math.floor(fMin / df));
  const kMax = Math.min(dB.length - 1, Math.ceil(fMax / df));
  const paso = Math.max(1, Math.ceil((kMax - kMin) / maxPuntos));
  const f = [];
  const y = [];
  for (let k = kMin; k <= kMax; k += paso) {
    let mejor = k;
    for (let j = k; j < Math.min(k + paso, kMax + 1); j++) {
      if (dB[j] > dB[mejor]) mejor = j;
    }
    f.push(mejor * df);
    y.push(dB[mejor]);
  }
  return { f, y };
}

// Diezmado simple de la señal en el tiempo: una muestra cada `paso`.
function diezmarTiempo(x, fs, maxPuntos = 20000) {
  const paso = Math.max(1, Math.floor(x.length / maxPuntos));
  const t = [];
  const y = [];
  for (let n = 0; n < x.length; n += paso) {
    t.push(n / fs);
    y.push(x[n]);
  }
  return { t, y };
}

/** Dibuja un gráfico en el contenedor `id`, reemplazando el anterior si existía. */
function dibujar(id, trazas, layout) {
  const base = {
    margin: { l: 60, r: 20, t: 40, b: 50 },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: 'system-ui, sans-serif', size: 12 },
    legend: { orientation: 'h', y: -0.2 },
  };
  Plotly.react(id, trazas, { ...base, ...layout }, { responsive: true, displaylogo: false });
}

// a) Forma de onda, potencia por ventanas y tramo analizado.
export function graficaForma(id, res) {
  const { x, envolvente, tramo, onsetS } = res.senal;
  const onda = diezmarTiempo(x, res.fs);
  const tEnv = Array.from(envolvente.tiempos);
  const envLineal = Array.from(envolvente.envDB, (db) => 10 ** (db / 20));
  dibujar(id, [
    { x: onda.t, y: onda.y, type: 'scattergl', mode: 'lines', name: 'Señal', line: { color: COLORES.senal, width: 1 } },
    { x: tEnv, y: envLineal, type: 'scatter', mode: 'lines', name: 'Potencia por ventanas (RMS)', line: { color: COLORES.envolvente, width: 2 } },
  ], {
    title: 'a) Forma de onda, potencia y tramo analizado',
    xaxis: { title: 'Tiempo (s)' },
    yaxis: { title: 'Amplitud', range: [-1.05, 1.05] },
    shapes: [
      { type: 'rect', xref: 'x', yref: 'paper', x0: tramo.inicioS, x1: tramo.finS, y0: 0, y1: 1, fillcolor: COLORES.tramo, line: { width: 0 } },
      { type: 'line', xref: 'x', yref: 'paper', x0: onsetS, x1: onsetS, y0: 0, y1: 1, line: { color: '#666', dash: 'dot' } },
    ],
    annotations: [
      { x: onsetS, yref: 'paper', y: 1, text: 'onset', showarrow: false, yanchor: 'bottom' },
      { x: (tramo.inicioS + tramo.finS) / 2, yref: 'paper', y: 0.02, text: 'tramo analizado', showarrow: false },
    ],
  });
}

// b) Espectro del ruido previo, con el zumbido marcado.
export function graficaRuido(id, res) {
  if (!res.ruido.espectro) {
    dibujar(id, [], { title: 'b) Espectro del ruido: no hay ruido previo disponible' });
    return;
  }
  const { f, y } = diezmarMaximo(res.ruido.espectro, 0, 500);
  const trazas = [{ x: f, y, type: 'scattergl', mode: 'lines', name: 'Ruido', line: { color: COLORES.senal } }];
  if (res.ruido.zumbido.length) {
    trazas.push({
      x: res.ruido.zumbido.map((z) => z.f),
      y: res.ruido.zumbido.map((z) => z.excesoDB),
      type: 'scatter',
      mode: 'markers',
      name: 'Zumbido detectado (exceso en dB)',
      marker: { color: COLORES.armonicos, size: 9 },
      yaxis: 'y2',
    });
  }
  dibujar(id, trazas, {
    title: res.ruido.zumbidoDetectado ? 'b) Espectro del ruido: zumbido de red detectado' : 'b) Espectro del ruido: sin zumbido significativo',
    xaxis: { title: 'Frecuencia (Hz)', range: [0, 500] },
    yaxis: { title: 'Magnitud (dB)' },
    yaxis2: { overlaying: 'y', side: 'right', title: 'Exceso sobre el nivel medio (dB)', showgrid: false },
  });
}

// c) Respuesta en frecuencia del filtro aplicado.
export function graficaFiltros(id, res) {
  const { frecuencias, dBTotal } = res.filtros.respuesta;
  const notches = res.filtros.notches.aplicados;
  dibujar(id, [
    { x: Array.from(frecuencias), y: Array.from(dBTotal), type: 'scatter', mode: 'lines', name: 'Respuesta del filtro', line: { color: COLORES.filtro, width: 2 } },
  ], {
    title: 'c) Respuesta en frecuencia del filtro',
    xaxis: { title: 'Frecuencia (Hz)', type: 'log' },
    yaxis: { title: 'Módulo (dB)', range: [-40, 5] },
    annotations: notches.length
      ? [{ x: Math.log10(notches[0]), xref: 'x', y: 0, text: `notch: ${notches.join(', ')} Hz`, showarrow: false, yshift: 14 }]
      : [],
  });
}

// d) Espectro antes y después del filtrado.
export function graficaAntesDespues(id, res) {
  const rango = Math.min(res.fs / 2, 2000);
  const antes = diezmarMaximo(res.espectros.antes, 0, rango);
  const despues = diezmarMaximo(res.espectros.despues, 0, rango);
  dibujar(id, [
    { x: antes.f, y: antes.y, type: 'scattergl', mode: 'lines', name: 'Antes del filtrado', line: { color: COLORES.senal } },
    { x: despues.f, y: despues.y, type: 'scattergl', mode: 'lines', name: 'Después del filtrado', line: { color: COLORES.despues } },
  ], {
    title: 'd) Espectro del tramo: antes y después del filtrado',
    xaxis: { title: 'Frecuencia (Hz)' },
    yaxis: { title: 'Magnitud (dB)' },
  });
}

// e) Espectro con los armónicos medidos y las líneas ideales k·f0.
export function graficaArmonicos(id, res) {
  const f0 = res.f0;
  const rango = res.modo === 'vibrafono' ? Math.min(res.fs / 2, 5000) : Math.min(res.fs / 2, 14 * f0);
  const esp = diezmarMaximo(res.espectros.despues, 0, rango, 8000);
  const trazas = [{ x: esp.f, y: esp.y, type: 'scattergl', mode: 'lines', name: 'Espectro', line: { color: COLORES.despues } }];
  const shapes = [];

  if (res.modo === 'vibrafono') {
    trazas.push({
      x: res.parciales.map((p) => p.frecuenciaHz),
      y: res.parciales.map((p) => p.amplitudDB),
      type: 'scatter', mode: 'markers+text', name: 'Parciales',
      text: res.parciales.map((p) => `${p.razon.toFixed(2)}·f0`), textposition: 'top center',
      marker: { color: COLORES.armonicos, size: 9 },
    });
  } else {
    for (let k = 1; k * f0 <= rango; k++) {
      shapes.push({ type: 'line', xref: 'x', yref: 'paper', x0: k * f0, x1: k * f0, y0: 0, y1: 1, line: { color: COLORES.ideal, dash: 'dot', width: 1 } });
    }
    trazas.push({
      x: res.armonicos.map((a) => a.frecuenciaHz),
      y: res.armonicos.map((a) => a.amplitudDB),
      type: 'scatter', mode: 'markers+text', name: 'Armónicos medidos',
      text: res.armonicos.map((a) => `${a.k}`), textposition: 'top center',
      marker: { color: COLORES.armonicos, size: 7 },
    });
  }

  dibujar(id, trazas, {
    title: res.modo === 'vibrafono' ? 'e) Parciales del vibráfono' : 'e) Armónicos medidos y líneas ideales k·f0 (punteadas)',
    xaxis: { title: 'Frecuencia (Hz)', range: [0, rango] },
    yaxis: { title: 'Magnitud (dB)' },
    shapes,
  });
}
