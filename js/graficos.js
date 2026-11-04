// graficos.js
// ------------------------------------------------------------------
// Todos los gráficos de la interfaz, hechos con Plotly.js (librería por CDN).
// Los seis gráficos del informe:
//   a) forma de onda + envolvente + tramo analizado
//   b) espectro del ruido (con el zumbido marcado)
//   c) respuesta en frecuencia de los filtros
//   d) espectro antes / después del filtrado
//   e) espectro del tramo con armónicos marcados e ideales k·f0
//   f) desviación en cents vs k, con la curva del modelo ajustado
// ------------------------------------------------------------------

const COLORES = {
  senal: '#9aa4b2',
  envolvente: '#1f6feb',
  tramo: 'rgba(31, 111, 235, 0.12)',
  antes: '#9aa4b2',
  despues: '#1f6feb',
  armonicos: '#d1242f',
  ideal: '#1a7f37',
  modelo: '#8250df',
  filtro: '#bc4c00',
};

// Configuración común: sin barra de herramientas innecesaria, con el botón de PNG.
const CONFIG = {
  responsive: true,
  displaylogo: false,
  modeBarButtonsToRemove: ['lasso2d', 'select2d'],
};

/**
 * Submuestreo para graficar: de cada bloque de `paso` puntos conservamos el
 * máximo (y su frecuencia). Así un espectro de 1 millón de puntos se dibuja
 * con unos pocos miles sin perder los picos, que son lo que importa visualmente.
 * Trabaja sólo dentro del rango [fMin, fMax] en Hz.
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

// Diezmado simple (para la señal en el tiempo): toma una muestra cada `paso`.
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

/** Dibuja un gráfico en el contenedor `id`. Si ya había uno, lo reemplaza. */
function dibujar(id, trazas, layout) {
  const base = {
    margin: { l: 60, r: 20, t: 40, b: 50 },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: 'system-ui, sans-serif', size: 12 },
    legend: { orientation: 'h', y: -0.2 },
  };
  Plotly.react(id, trazas, { ...base, ...layout }, CONFIG);
}

/** Descarga el gráfico como PNG (para pegar en el informe). */
export function descargarPNG(id, nombre) {
  Plotly.downloadImage(id, { format: 'png', width: 1400, height: 700, filename: nombre });
}

// a) Forma de onda, envolvente y tramo analizado.
export function graficaForma(id, res) {
  const { x, envolvente, tramo, onsetS } = res.senal;
  const onda = diezmarTiempo(x, res.fs);
  const env = envolvente;
  const tEnv = Array.from(env.tiempos);
  const envLineal = Array.from(env.envDB, (db) => 10 ** (db / 20));
  const trazas = [
    { x: onda.t, y: onda.y, type: 'scattergl', mode: 'lines', name: 'Señal', line: { color: COLORES.senal, width: 1 } },
    { x: tEnv, y: envLineal, type: 'scatter', mode: 'lines', name: 'Envolvente RMS', line: { color: COLORES.envolvente, width: 2 } },
  ];
  const layout = {
    title: 'a) Forma de onda, envolvente y tramo analizado',
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
  };
  dibujar(id, trazas, layout);
}

// b) Espectro del ruido previo, con los armónicos de 50 Hz marcados.
export function graficaRuido(id, res) {
  if (!res.ruido.espectro) {
    dibujar(id, [], { title: 'b) Espectro del ruido: no hay ruido disponible' });
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
    yaxis2: { overlaying: 'y', side: 'right', title: 'Exceso sobre el piso (dB)', showgrid: false },
  });
}

// c) Respuesta en frecuencia de los filtros usados.
export function graficaFiltros(id, res) {
  const { frecuencias, dBTotal, dBHp } = res.filtros.respuesta;
  const trazas = [
    { x: Array.from(frecuencias), y: Array.from(dBHp), type: 'scatter', mode: 'lines', name: `Pasa-altos Butterworth orden ${res.filtros.hp.orden}, fc = ${res.filtros.hp.fc.toFixed(1)} Hz`, line: { color: COLORES.filtro, dash: 'dash' } },
    { x: Array.from(frecuencias), y: Array.from(dBTotal), type: 'scatter', mode: 'lines', name: 'Total (pasa-altos + notches)', line: { color: COLORES.despues, width: 2 } },
  ];
  const notches = res.filtros.notches.aplicados;
  dibujar(id, trazas, {
    title: `c) Respuesta en frecuencia de los filtros (Q notch = ${res.filtros.notches.Q})`,
    xaxis: { title: 'Frecuencia (Hz)', type: 'log' },
    yaxis: { title: 'Módulo (dB)', range: [-80, 5] },
    annotations: notches.length
      ? [{ x: Math.log10(notches[0]), xref: 'x', y: 0, text: `notches: ${notches.join(', ')} Hz`, showarrow: false, yshift: 14 }]
      : [],
  });
}

// d) Espectro antes y después del filtrado.
export function graficaAntesDespues(id, res) {
  const rango = Math.min(res.fs / 2, 2000);
  const antes = diezmarMaximo(res.espectros.antes, 0, rango);
  const despues = diezmarMaximo(res.espectros.despues, 0, rango);
  dibujar(id, [
    { x: antes.f, y: antes.y, type: 'scattergl', mode: 'lines', name: 'Antes del filtrado', line: { color: COLORES.antes } },
    { x: despues.f, y: despues.y, type: 'scattergl', mode: 'lines', name: 'Después del filtrado', line: { color: COLORES.despues } },
  ], {
    title: 'd) Espectro del tramo: antes y después del filtrado',
    xaxis: { title: 'Frecuencia (Hz)' },
    yaxis: { title: 'Magnitud (dB)' },
  });
}

// e) Espectro del tramo con armónicos medidos e ideales k·f0.
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
    // Líneas verticales punteadas en k·f0 (ideal) y marcas en los armónicos medidos.
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
    title: res.modo === 'vibrafono' ? 'e) Parciales del vibráfono' : 'e) Armónicos medidos vs. ideales k·f0 (líneas punteadas)',
    xaxis: { title: 'Frecuencia (Hz)', range: [0, rango] },
    yaxis: { title: 'Magnitud (dB)' },
    shapes,
  });
}

// f) Desviación en cents vs k, con la curva del modelo ajustado (B).
export function graficaDesvio(id, res) {
  const kMax = Math.max(...res.armonicos.map((a) => a.k), 2);
  const ks = [];
  const modelo = [];
  for (let k = 1; k <= kMax; k += 0.25) {
    ks.push(k);
    modelo.push(1200 * Math.log2(Math.sqrt(1 + res.B * k * k)));
  }
  dibujar(id, [
    {
      x: res.armonicos.map((a) => a.k),
      y: res.armonicos.map((a) => a.desvioCents),
      type: 'scatter', mode: 'markers', name: 'Medido vs. k·f0 (ajustado)',
      marker: { color: COLORES.armonicos, size: 7 },
    },
    { x: ks, y: modelo, type: 'scatter', mode: 'lines', name: `Modelo con B = ${res.B.toExponential(2)}`, line: { color: COLORES.modelo } },
  ], {
    title: 'f) Desviación de cada armónico respecto de k·f0 (cents)',
    xaxis: { title: 'Número de armónico k' },
    yaxis: { title: 'Desviación (cents)', zeroline: true },
  });
}
