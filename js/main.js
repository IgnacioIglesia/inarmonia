// main.js
// ------------------------------------------------------------------
// Orquesta la interfaz: lee los controles, llama al pipeline y muestra
// resumen, tabla, advertencias y gráficos. No hace matemática propia:
// toda la lógica de procesamiento está en pipeline.js y sus módulos.
// ------------------------------------------------------------------

import { decodificarArchivo, prepararSenal, iniciarGrabacion } from './audio.js';
import { analizarNota } from './pipeline.js';
import * as graficos from './graficos.js';
import { generarNotaSintetica } from '../test/sintetica.js';

const $ = (id) => document.getElementById(id);

// Estado de la aplicación: la señal cargada y la grabación en curso (si hay).
const estado = {
  senal: null,        // { x, fs, bits, canales, nombre }
  silencio: null,     // Float64Array con sólo ruido, o null
  grabacion: null,    // objeto devuelto por iniciarGrabacion()
  resultado: null,    // último resultado del pipeline (para la tabla y el CSV)
};

// Mensaje de estado (y de error) debajo del botón Analizar.
function mostrarEstado(texto, esError = false) {
  const el = $('estado');
  el.textContent = texto;
  el.style.color = esError ? 'var(--falla)' : '';
}

// Lee los parámetros de la interfaz, con los mismos nombres que OPCIONES_POR_DEFECTO.
function leerOpciones() {
  return {
    instrumento: $('instrumento').value,
    ventana: $('ventana').value,
    fcHP: Number($('fc-hp').value),
    inicioMs: Number($('inicio-ms').value),
    duracionMaxS: Number($('duracion-max').value),
    umbralPicosDB: Number($('umbral-picos').value),
    silencio: estado.silencio,
  };
}


// Muestra fs, duración y bits (si se conocen) de la señal cargada.
function mostrarInfoSenal() {
  const s = estado.senal;
  if (!s) return;
  const bits = s.bits ? `${s.bits} bits` : 'bits: no aplica (float)';
  $('info-senal').textContent =
    `${s.nombre} · fs = ${s.fs} Hz · duración = ${(s.x.length / s.fs).toFixed(2)} s · ${bits} · canales originales: ${s.canales}`;
}

// Carga una señal nueva (ya decodificada) y la analiza de inmediato.
function fijarSenal(datos, nombre) {
  estado.senal = {
    x: prepararSenal(datos.canales),
    fs: datos.fs,
    bits: datos.bits,
    canales: datos.canales.length,
    nombre,
  };
  mostrarInfoSenal();
  analizar();
}

// Analizar: corre el pipeline. setTimeout deja pintar el mensaje "Analizando..." antes del cálculo pesado.
function analizar() {
  if (!estado.senal) {
    mostrarEstado('Primero cargá o grabá una señal.', true);
    return;
  }
  mostrarEstado('Analizando... (la FFT de alta resolución puede tardar unos segundos)');
  setTimeout(() => {
    try {
      const { x, fs } = estado.senal;
      const resultado = analizarNota(x, fs, leerOpciones());
      estado.resultado = resultado;
      mostrarResultados(resultado);
      mostrarEstado('Listo.');
    } catch (error) {
      console.error(error);
      mostrarEstado(`Error al analizar: ${error.message}`, true);
    }
  }, 30);
}

// Formatea un número o devuelve un guion si no hay dato.
const num = (valor, decimales) => (valor === null || valor === undefined || Number.isNaN(valor) ? '—' : valor.toFixed(decimales));

function mostrarResumen(r) {
  const esVibra = r.modo === 'vibrafono';
  $('r-nota').textContent = r.nota ? r.nota.nombreES : '—';
  $('r-nota-en').textContent = r.nota ? `(${r.nota.nombreEN})` : '';
  $('r-f0').textContent = num(r.f0, 3);
  $('r-afinacion').textContent = r.nota ? `${r.nota.afinacionHz >= 0 ? '+' : ''}${num(r.nota.afinacionHz, 3)} Hz` : '—';
  $('r-afinacion-cents').textContent = r.nota ? `${r.nota.afinacionCents >= 0 ? '+' : ''}${num(r.nota.afinacionCents, 1)} cents` : '';
  $('r-b').textContent = esVibra ? '—' : r.B === null ? '—' : r.B.toExponential(2);
  $('r-r2').textContent = esVibra || r.R2 === null ? '' : `R² = ${num(r.R2, 6)}`;
  $('r-cantidad-etiqueta').textContent = esVibra ? 'Parciales detectados' : 'Armónicos detectados';
  $('r-cantidad').textContent = esVibra ? r.parciales.length : r.armonicos.length;
  $('r-cantidad-nota').textContent = esVibra ? '' : `f0 gruesa = ${num(r.f0Grueso, 3)} Hz`;
}

function mostrarAdvertencias(r) {
  const lista = $('lista-advertencias');
  lista.innerHTML = '';
  for (const texto of r.advertencias) {
    const li = document.createElement('li');
    li.textContent = texto;
    lista.appendChild(li);
  }
  $('seccion-advertencias').classList.toggle('oculta', r.advertencias.length === 0);
}

// Tabla de armónicos (cuerda) o de parciales (vibráfono).
// Las celdas sólo llevan números ya formateados: por eso usamos innerHTML sin riesgo.
function mostrarTabla(r) {
  const cabecera = $('cabecera-tabla');
  const cuerpo = $('cuerpo-tabla');
  cabecera.innerHTML = '';
  cuerpo.innerHTML = '';

  if (r.modo === 'vibrafono') {
    $('titulo-tabla').textContent = 'Parciales (vibráfono)';
    cabecera.innerHTML = '<tr><th>n</th><th>Frecuencia (Hz)</th><th>Amplitud (dB rel.)</th><th>Razón f/f0</th><th>Razón teórica</th><th>Diferencia</th></tr>';
    for (const p of r.parciales) {
      cuerpo.innerHTML += `<tr><td>${p.n}</td><td>${num(p.frecuenciaHz, 3)}</td><td>${num(p.amplitudRelDB, 1)}</td><td>${num(p.razon, 3)}</td><td>${p.razonTeorica ?? '—'}</td><td>${num(p.diferenciaRazon, 3)}</td></tr>`;
    }
    return;
  }

  $('titulo-tabla').textContent = 'Armónicos';
  cabecera.innerHTML = '<tr><th>k</th><th>Frecuencia medida (Hz)</th><th>Amplitud (dB rel. k=1)</th><th>Desvío vs k·f0 (Hz)</th><th>Desvío vs k·f0 (cents)</th><th>Desvío vs modelo con B (cents)</th></tr>';
  for (const a of r.armonicos) {
    cuerpo.innerHTML += `<tr><td>${a.k}</td><td>${num(a.frecuenciaHz, 4)}</td><td>${num(a.amplitudRelDB, 1)}</td><td>${num(a.desvioHz, 4)}</td><td>${num(a.desvioCents, 2)}</td><td>${num(a.desvioModeloCents, 2)}</td></tr>`;
  }
}

// Exporta la tabla a CSV. Separador ";" (Excel en configuración española) y punto decimal.
function exportarCSV() {
  const r = estado.resultado;
  if (!r) return;
  const filas = [];
  if (r.modo === 'vibrafono') {
    filas.push(['n', 'frecuencia_Hz', 'amplitud_dB_rel', 'razon_f_f0', 'razon_teorica', 'diferencia']);
    for (const p of r.parciales) {
      filas.push([p.n, p.frecuenciaHz, p.amplitudRelDB, p.razon, p.razonTeorica ?? '', p.diferenciaRazon ?? '']);
    }
  } else {
    filas.push(['k', 'frecuencia_Hz', 'amplitud_dB_rel_k1', 'desvio_Hz', 'desvio_cents', 'desvio_modelo_cents']);
    for (const a of r.armonicos) {
      filas.push([a.k, a.frecuenciaHz, a.amplitudRelDB, a.desvioHz, a.desvioCents, a.desvioModeloCents]);
    }
  }
  const texto = filas.map((fila) => fila.map((c) => (typeof c === 'number' ? c.toPrecision(10) : c)).join(';')).join('\n');
  const blob = new Blob([texto], { type: 'text/csv;charset=utf-8' });
  const enlace = document.createElement('a');
  enlace.href = URL.createObjectURL(blob);
  enlace.download = `${r.modo === 'vibrafono' ? 'parciales' : 'armonicos'}.csv`;
  enlace.click();
  URL.revokeObjectURL(enlace.href);
}

// Dibuja los seis gráficos. La desviación en cents sólo tiene sentido en modo cuerda.
function mostrarGraficos(r) {
  graficos.graficaForma('g-forma', r);
  graficos.graficaRuido('g-ruido', r);
  graficos.graficaFiltros('g-filtros', r);
  graficos.graficaAntesDespues('g-antes-despues', r);
  graficos.graficaArmonicos('g-armonicos', r);
  if (r.modo === 'vibrafono') {
    document.getElementById('g-desvio').innerHTML = '<p class="nota">Este gráfico aplica sólo al modo cuerda (en vibráfono no se fuerza k·f0).</p>';
  } else {
    graficos.graficaDesvio('g-desvio', r);
  }
}

function mostrarResultados(r) {
  mostrarAdvertencias(r);
  mostrarResumen(r);
  mostrarTabla(r);
  mostrarGraficos(r);
  $('seccion-resultados').classList.remove('oculta');
}

// ---------- Eventos ----------

$('archivo').addEventListener('change', async (evento) => {
  const archivo = evento.target.files[0];
  if (!archivo) return;
  mostrarEstado('Decodificando archivo...');
  try {
    const datos = await decodificarArchivo(archivo);
    fijarSenal(datos, archivo.name);
  } catch (error) {
    mostrarEstado(`No se pudo leer el archivo: ${error.message}`, true);
  }
});

$('archivo-silencio').addEventListener('change', async (evento) => {
  const archivo = evento.target.files[0];
  if (!archivo) {
    estado.silencio = null;
    $('info-silencio').textContent = '';
    return;
  }
  try {
    const datos = await decodificarArchivo(archivo);
    estado.silencio = prepararSenal(datos.canales);
    $('info-silencio').textContent = `Silencio cargado: ${archivo.name} (${(estado.silencio.length / datos.fs).toFixed(2)} s).`;
  } catch (error) {
    mostrarEstado(`No se pudo leer el archivo de silencio: ${error.message}`, true);
  }
});

$('btn-grabar').addEventListener('click', async () => {
  const boton = $('btn-grabar');
  if (!estado.grabacion) {
    try {
      estado.grabacion = await iniciarGrabacion();
      boton.textContent = 'Detener grabación';
      boton.classList.add('grabando');
      mostrarEstado('Grabando... tocá la nota y después detené la grabación.');
    } catch (error) {
      mostrarEstado(`No hay acceso al micrófono: ${error.message}`, true);
    }
    return;
  }
  const grabacion = estado.grabacion;
  estado.grabacion = null;
  boton.textContent = 'Grabar con micrófono';
  boton.classList.remove('grabando');
  try {
    const datos = await grabacion.stop();
    fijarSenal(datos, 'grabación de micrófono');
  } catch (error) {
    mostrarEstado(`No se pudo procesar la grabación: ${error.message}`, true);
  }
});

$('btn-sintetica').addEventListener('click', () => {
  // Nota de prueba: f0 = 55 Hz y B = 3e-4, con ruido y zumbido (ver test/sintetica.js).
  const { x, fs } = generarNotaSintetica({ f0: 55, B: 3e-4 });
  estado.senal = { x: prepararSenal([x]), fs, bits: null, canales: 1, nombre: 'Señal sintética (f0 = 55 Hz, B = 3·10⁻⁴)' };
  mostrarInfoSenal();
  analizar();
});

$('btn-analizar').addEventListener('click', analizar);
$('btn-csv').addEventListener('click', exportarCSV);

// Botones de descarga PNG: cada uno indica qué gráfico y con qué nombre.
document.querySelectorAll('.btn-png').forEach((boton) => {
  boton.addEventListener('click', () => {
    graficos.descargarPNG(boton.dataset.grafico, boton.dataset.nombre);
  });
});
