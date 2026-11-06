// validacion.mjs
// ------------------------------------------------------------------
// Prueba el pipeline con señales sintéticas de verdad conocida:
// f0 y B reales se fijan al generar la señal, y el análisis debe recuperarlos.
// Cada señal tiene silencio con ruido y zumbido de red (50 Hz y 100 Hz) antes
// de la nota, para ejercitar el filtrado.
// Correr con:  node --experimental-default-type=module pruebas/validacion.mjs
// ------------------------------------------------------------------

import { analizarNota } from '../js/pipeline.js';

const FS = 44100;

// Generador pseudoaleatorio (congruencial lineal) para que el ruido sea reproducible.
function generadorRuido(semilla) {
  let estado = semilla >>> 0;
  return () => {
    estado = (Math.imul(estado, 1664525) + 1013904223) >>> 0;
    return estado / 2 ** 32 - 0.5;
  };
}

// Señal: 1 s de silencio con zumbido y ruido, después la nota con armónicos
// de amplitud 1/k que decaen lentamente. Los armónicos siguen f_k = k·f0·√(1 + B·k²).
function generarNota({ f0, B, duracionS = 6, semilla = 1 }) {
  const ruido = generadorRuido(semilla);
  const N = Math.round(duracionS * FS);
  const onsetS = 1.2;
  const x = new Float64Array(N);
  const parciales = [];
  for (let k = 1; k * f0 < FS / 2; k++) {
    const fk = k * f0 * Math.sqrt(1 + B * k * k);
    if (fk >= FS / 2 * 0.95) break;
    parciales.push({ fk, amp: 1 / k });
  }
  for (let n = 0; n < N; n++) {
    const t = n / FS;
    let v = 0.01 * Math.sin(2 * Math.PI * 50 * t) + 0.005 * Math.sin(2 * Math.PI * 100 * t + 0.3);
    v += 0.002 * ruido() * 2;
    if (t >= onsetS) {
      const envolvente = Math.exp(-(t - onsetS) / 3);
      for (const p of parciales) v += envolvente * p.amp * Math.sin(2 * Math.PI * p.fk * t);
    }
    x[n] = v;
  }
  return { x, parciales };
}

const centsEntre = (a, b) => 1200 * Math.log2(a / b);

// Casos: f0 en la extensión de A0 a C8 (incluye las octavas bajas), B de cuerda rígida.
const casos = [
  { nombre: 'A0 (27,5 Hz), sin inarmonía', f0: 27.5, B: 0 },
  { nombre: 'A0 (27,5 Hz), inarmonía baja', f0: 27.5, B: 2e-4 },
  { nombre: 'G1 (49 Hz), junto al zumbido', f0: 49, B: 1e-4 },
  { nombre: 'A2 (110 Hz), inarmonía baja', f0: 110, B: 2e-4 },
  { nombre: 'A3 (220 Hz), inarmonía media', f0: 220, B: 6e-4 },
  { nombre: 'A4 (440 Hz), inarmonía alta', f0: 440, B: 1e-3 },
  { nombre: 'A6 (1760 Hz), sin inarmonía', f0: 1760, B: 0 },
  { nombre: 'C8 (4186 Hz), sin inarmonía', f0: 4186, B: 0 },
];

let fallos = 0;
for (const [i, caso] of casos.entries()) {
  const { x, parciales } = generarNota({ f0: caso.f0, B: caso.B, semilla: i + 7 });
  const r = analizarNota(x, FS, 'cuerda');

  const errorF0Cents = r.f0 === null ? Infinity : Math.abs(centsEntre(r.f0, caso.f0));
  const errorB = r.B === null ? Infinity : Math.abs(r.B - caso.B);
  const detectados = new Set(r.armonicos.map((a) => a.k));
  // Se exigen los parciales hasta k = 20: los de orden mayor caen bajo el ruido con amplitud 1/k.
  const requeridos = Math.min(20, parciales.length);
  const faltan = Array.from({ length: requeridos }, (_, i) => i + 1).filter((k) => !detectados.has(k));

  // Criterios: f0 dentro de 1 cent; B dentro de 1e-5 absoluto (o 20 % si B > 0);
  // todos los parciales requeridos detectados.
  const tolB = caso.B === 0 ? 1e-5 : Math.max(1e-5, 0.2 * caso.B);
  const ok = errorF0Cents < 1 && errorB <= tolB && faltan.length === 0;
  if (!ok) fallos++;

  console.log(`${ok ? 'OK  ' : 'FALLA'} ${caso.nombre}`);
  console.log(`     f0 medida = ${r.f0?.toFixed(3)} Hz (error ${errorF0Cents.toFixed(2)} cents)`);
  console.log(`     B medida  = ${r.B?.toExponential(3)} (real ${caso.B.toExponential(1)})`);
  console.log(`     armónicos = ${r.armonicos.length} (reales hasta k=${requeridos}: ${requeridos - faltan.length}/${requeridos})${faltan.length ? `; faltan k = ${faltan.join(', ')}` : ''}`);
  for (const a of r.armonicos.slice(0, 4)) {
    console.log(`       k=${a.k}  f=${a.frecuenciaHz.toFixed(3)} Hz  desvío=${a.desvioCents.toFixed(2)} cents`);
  }
  if (r.advertencias.length) console.log(`     advertencias: ${r.advertencias.join(' | ')}`);
}

console.log(fallos === 0 ? '\nTodos los casos pasaron.' : `\n${fallos} caso(s) fallaron.`);
process.exitCode = fallos === 0 ? 0 : 1;
