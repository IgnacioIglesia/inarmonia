// audio.js
// ------------------------------------------------------------------
// Entrada de la señal: carga de archivos (WAV/MP3), grabación con micrófono
// y preparación común (mono, quitar DC, normalizar).
// Las funciones que tocan el navegador (AudioContext, getUserMedia) están
// separadas de la preparación matemática, que sí puede probarse en Node.
// ------------------------------------------------------------------

/**
 * Preparación de la señal, igual para archivos, micrófono y señales sintéticas:
 *  1) Mono: si hay varios canales, promediamos (L+R)/2. Así el análisis no
 *     depende de cómo esté grabada la estéreo (la nota suena igual en los dos).
 *  2) Quitar DC: restamos la media. Una componente continua no es parte de la
 *     nota; aparece como un "escalón" y ensucia el espectro en 0 Hz.
 *  3) Normalizar: dividimos por el máximo absoluto para que la señal quede en
 *     [-1, 1]. Así las amplitudes de distintos archivos son comparables.
 * Devuelve un Float64Array nuevo (no modifica la entrada).
 */
export function prepararSenal(canales) {
  const N = canales[0].length;
  const mono = new Float64Array(N);
  for (const canal of canales) {
    for (let n = 0; n < N; n++) mono[n] += canal[n] / canales.length;
  }

  let media = 0;
  for (let n = 0; n < N; n++) media += mono[n];
  media /= N;

  let maximo = 0;
  for (let n = 0; n < N; n++) {
    mono[n] -= media;
    maximo = Math.max(maximo, Math.abs(mono[n]));
  }
  if (maximo > 0) {
    for (let n = 0; n < N; n++) mono[n] /= maximo;
  }
  return mono;
}

/**
 * Lee la profundidad de bits de un archivo WAV (campo bitsPerSample del
 * encabezado "fmt "). Web Audio decodifica todo a float, así que este dato no
 * viene de decodeAudioData: lo leemos directamente del archivo.
 * Devuelve null si no es un WAV reconocible (MP3, por ejemplo).
 */
export function leerBitsWav(arrayBuffer) {
  const vista = new DataView(arrayBuffer);
  const texto = (pos) => String.fromCharCode(...new Uint8Array(arrayBuffer, pos, 4));
  if (arrayBuffer.byteLength < 12 || texto(0) !== 'RIFF' || texto(8) !== 'WAVE') return null;
  let pos = 12;
  while (pos + 8 <= arrayBuffer.byteLength) {
    const id = texto(pos);
    const tam = vista.getUint32(pos + 4, true);
    if (id === 'fmt ') return vista.getUint16(pos + 22, true);
    pos += 8 + tam + (tam % 2); // los chunks van alineados a 2 bytes
  }
  return null;
}

/**
 * Decodifica un archivo (WAV, MP3, OGG...) con la Web Audio API.
 * decodeAudioData hace el trabajo pesado: devuelve los canales en float
 * y la frecuencia de muestreo real del archivo (fs).
 * Esta función sólo corre en el navegador.
 */
export async function decodificarArchivo(archivo) {
  const buffer = await archivo.arrayBuffer();
  const contexto = new AudioContext();
  try {
    // decodeAudioData "consume" el buffer: por eso leemos los bits antes.
    const bits = leerBitsWav(buffer.slice(0));
    const audio = await contexto.decodeAudioData(buffer);
    const canales = [];
    for (let c = 0; c < audio.numberOfChannels; c++) {
      canales.push(Float64Array.from(audio.getChannelData(c)));
    }
    return { canales, fs: audio.sampleRate, bits, duracionS: audio.duration };
  } finally {
    contexto.close();
  }
}

/**
 * Grabación con micrófono. Usamos MediaRecorder (graba el stream tal como
 * llega) y al final decodificamos el blob con la misma función que los archivos.
 * Devuelve un objeto con stop() que resuelve a { canales, fs, ... }.
 * Nota: los navegadores exigen https o localhost para permitir el micrófono.
 */
export async function iniciarGrabacion() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const grabador = new MediaRecorder(stream);
  const fragmentos = [];
  grabador.ondataavailable = (e) => {
    if (e.data.size > 0) fragmentos.push(e.data);
  };
  grabador.start();

  return {
    stop() {
      return new Promise((resolver, rechazar) => {
        grabador.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          try {
            const blob = new Blob(fragmentos, { type: grabador.mimeType });
            const archivo = new File([blob], 'grabacion', { type: blob.type });
            resolver(await decodificarArchivo(archivo));
          } catch (error) {
            rechazar(error);
          }
        };
        grabador.stop();
      });
    },
  };
}
