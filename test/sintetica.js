// sintetica.js
// ------------------------------------------------------------------
// Genera señales sintéticas de una nota de cuerda con f0 y B CONOCIDOS.
// Como sabemos la respuesta verdadera, podemos medir qué tan bien la
// recupera el pipeline. Es la prueba de validación del proyecto.
//
// Modelo de la nota:
//   x(t) = Σ_k A_k · e^(-t/τ) · sen(2π·f_k·t + φ_k),   f_k = k·f0·√(1+B·k²)
//   A_k = k^(-1.2)  (los armónicos decaen con k)
// Además: ataque con ruido (el golpe de martillo o púa), ruido blanco
// y zumbido de 50 Hz con sus armónicos. Antes de la nota hay 0.6 s con
// sólo ruido y zumbido, para poder medir el ruido de fondo.
// ------------------------------------------------------------------

/**
 * Generador pseudoaleatorio determinístico (LCG). Así el resultado de la
 * validación es siempre el mismo y se puede repetir.
 */
function generadorAleatorio(semilla = 12345) {
  let estado = semilla >>> 0;
  return () => {
    estado = (Math.imul(estado, 1664525) + 1013904223) >>> 0;
    return estado / 4294967296;
  };
}

/** Ruido gaussiano (Box-Muller) con desvío sigma. */
function ruidoGaussiano(aleatorio, sigma) {
  const u1 = Math.max(aleatorio(), 1e-12);
  const u2 = aleatorio();
  return sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Genera una nota sintética.
 * opciones:
 *  - f0, B: frecuencia fundamental (Hz) e inarmonía.
 *  - fs: frecuencia de muestreo (44100 por defecto).
 *  - duracionS: largo total de la señal.
 *  - silencioS: segundos de sólo ruido antes de la nota.
 *  - tauS: constante de decaimiento exponencial.
 *  - ruidoSigma: desvío del ruido blanco.
 *  - zumbidoAmp: amplitud del zumbido de 50 Hz (y 100, 150 con la mitad de amplitud).
 *  - ataqueAmp: amplitud del ruido de ataque (martillo/púa).
 * Devuelve { x, fs, verdad } donde verdad tiene f0, B y la lista de f_k reales.
 */
export function generarNotaSintetica(opciones = {}) {
  const f0 = opciones.f0;
  const B = opciones.B ?? 0;
  const fs = opciones.fs ?? 44100;
  const duracionS = opciones.duracionS ?? 6;
  const silencioS = opciones.silencioS ?? 0.6;
  const tauS = opciones.tauS ?? 3;
  const ruidoSigma = opciones.ruidoSigma ?? 0.003;
  const zumbidoAmp = opciones.zumbidoAmp ?? 0.02;
  const ataqueAmp = opciones.ataqueAmp ?? 0.05;

  const N = Math.round(duracionS * fs);
  const inicioNota = Math.round(silencioS * fs);
  const aleatorio = generadorAleatorio(opciones.semilla ?? 12345);

  // Armónicos verdaderos: hasta 60 o hasta 10 kHz, lo que llegue antes.
  const verdad = { f0, B, armonicos: [] };
  for (let k = 1; k <= 60; k++) {
    const fk = k * f0 * Math.sqrt(1 + B * k * k);
    if (fk > 10000) break;
    verdad.armonicos.push({ k, f: fk, A: k ** -1.2, fase: 2 * Math.PI * aleatorio() });
  }

  const x = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    const t = n / fs;

    // Ruido de fondo y zumbido de red: presentes en toda la grabación.
    let v = ruidoGaussiano(aleatorio, ruidoSigma);
    v += zumbidoAmp * Math.sin(2 * Math.PI * 50 * t);
    v += 0.5 * zumbidoAmp * Math.sin(2 * Math.PI * 100 * t + 0.3);
    v += 0.25 * zumbidoAmp * Math.sin(2 * Math.PI * 150 * t + 1.1);

    // La nota: arranca en inicioNota con un ataque ruidoso que decae en ~20 ms.
    if (n >= inicioNota) {
      const ts = (n - inicioNota) / fs;
      const ataque = ataqueAmp * Math.exp(-ts / 0.02) * ruidoGaussiano(aleatorio, 1);
      let nota = 0;
      for (const h of verdad.armonicos) {
        nota += h.A * Math.sin(2 * Math.PI * h.f * ts + h.fase);
      }
      v += Math.exp(-ts / tauS) * nota * 0.3 + ataque;
    }
    x[n] = v;
  }

  return { x, fs, verdad };
}
