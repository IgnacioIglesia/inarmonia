// main.js
// ------------------------------------------------------------------
// Conecta la interfaz con el pipeline: lee la señal y el instrumento,
// llama a analizarNota() y muestra el resumen, la tabla y los gráficos.
// No hace procesamiento propio.
// ------------------------------------------------------------------

import { decodificarArchivo, prepararSenal, iniciarGrabacion } from './audio.js';
import { analizarNota } from './pipeline.js';
import * as graficos from './graficos.js';

const $ = (id) => document.getElementById(id);

// Estado: la señal cargada y la grabación en curso (si hay).
const estado = {
  senal: null,     // { x, fs, nombre }
  grabacion: null, // objeto devuelto por iniciarGrabacion()
};

function mostrarEstado(texto, esError = false) {
  const el = $('estado');
  el.textContent = texto;
  el.style.color = esError ? '#d1242f' : '';
}

// Formatea un número o devuelve un guion si no hay dato.
const num = (valor, decimales) =>
  valor === null || valor === undefined || Number.isNaN(valor) ? '—' : valor.toFixed(decimales);

// Analiza la señal cargada con el instrumento elegido.
// setTimeout deja pintar el mensaje "Analizando..." antes del cálculo.
function analizar() {
  if (!estado.senal) {
    mostrarEstado('Primero cargá o grabá una señal.', true);
    return;
  }
  mostrarEstado('Analizando... (la DFT de alta resolución puede tardar unos segundos)');
  setTimeout(() => {
    try {
      const { x, fs } = estado.senal;
      const resultado = analizarNota(x, fs, $('instrumento').value);
      mostrarResultados(resultado);
      mostrarEstado('Listo.');
    } catch (error) {
      console.error(error);
      mostrarEstado(`Error al analizar: ${error.message}`, true);
    }
  }, 30);
}

// Carga una señal nueva (ya decodificada) y la analiza.
function fijarSenal(datos, nombre) {
  estado.senal = { x: prepararSenal(datos.canales), fs: datos.fs, nombre };
  $('info-senal').textContent =
    `${nombre} · fs = ${datos.fs} Hz · duración = ${(estado.senal.x.length / datos.fs).toFixed(2)} s`;
  analizar();
}

function mostrarResumen(r) {
  const esVibra = r.modo === 'vibrafono';
  $('r-nota').textContent = r.nota ? r.nota.nombreES : '—';
  $('r-nota-en').textContent = r.nota ? `(${r.nota.nombreEN})` : '';
  $('r-f0').textContent = num(r.f0, 3);
  $('r-afinacion').textContent = r.nota ? `${r.nota.afinacionHz >= 0 ? '+' : ''}${num(r.nota.afinacionHz, 3)} Hz` : '—';
  $('r-afinacion-cents').textContent = r.nota ? `${r.nota.afinacionCents >= 0 ? '+' : ''}${num(r.nota.afinacionCents, 1)} cents` : '';
  $('r-cantidad-etiqueta').textContent = esVibra ? 'Parciales detectados' : 'Armónicos detectados';
  $('r-cantidad').textContent = esVibra ? r.parciales.length : r.armonicos.length;
  $('r-inarmonia').textContent = esVibra || r.B === null ? '—' : r.B.toExponential(2);
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
// Las celdas sólo llevan números ya formateados, así que usamos innerHTML sin riesgo.
function mostrarTabla(r) {
  const cabecera = $('cabecera-tabla');
  const cuerpo = $('cuerpo-tabla');
  cabecera.innerHTML = '';
  cuerpo.innerHTML = '';

  if (r.modo === 'vibrafono') {
    $('titulo-tabla').textContent = 'Parciales (vibráfono)';
    cabecera.innerHTML = '<tr><th>n</th><th>Frecuencia (Hz)</th><th>Amplitud (dB rel.)</th><th>Razón f/f0</th></tr>';
    for (const p of r.parciales) {
      cuerpo.innerHTML += `<tr><td>${p.n}</td><td>${num(p.frecuenciaHz, 3)}</td><td>${num(p.amplitudRelDB, 1)}</td><td>${num(p.razon, 3)}</td></tr>`;
    }
    return;
  }

  $('titulo-tabla').textContent = 'Armónicos';
  cabecera.innerHTML = '<tr><th>k</th><th>Frecuencia medida (Hz)</th><th>Amplitud (dB rel. k=1)</th><th>Desvío vs k·f0 (Hz)</th><th>Desvío vs k·f0 (cents)</th></tr>';
  for (const a of r.armonicos) {
    cuerpo.innerHTML += `<tr><td>${a.k}</td><td>${num(a.frecuenciaHz, 4)}</td><td>${num(a.amplitudRelDB, 1)}</td><td>${num(a.desvioHz, 4)}</td><td>${num(a.desvioCents, 2)}</td></tr>`;
  }
}

function mostrarGraficos(r) {
  graficos.graficaForma('g-forma', r);
  graficos.graficaRuido('g-ruido', r);
  graficos.graficaFiltros('g-filtros', r);
  graficos.graficaAntesDespues('g-antes-despues', r);
  graficos.graficaArmonicos('g-armonicos', r);
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

$('btn-analizar').addEventListener('click', analizar);
