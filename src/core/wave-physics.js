// src/core/wave-physics.js
// Física de dispersión de ondas de gravedad-capilaridad (agua), compartida
// entre las dos simulaciones visuales (cimática y gotas) para que ambas
// deriven longitud de onda de la MISMA frecuencia real, con el mismo modelo
// físico — antes solo cimática lo hacía (`faradayWavenumber`, extraído de
// `cymatics.js`) y gotas usaba una velocidad de onda constante para todas
// las frecuencias (auditoría 2026-08-29).
//
//   ω_s² = g·k + (σ/ρ)·k³
//
// Newton-Raphson resuelve k para una ω_s dada. A frecuencias bajas domina la
// gravedad (k ∝ f², longitud de onda grande); a frecuencias altas domina la
// capilaridad (k ∝ f^(2/3)).

// Constantes físicas del agua (~20 °C, unidades SI).
export const G = 9.81; // gravedad (m/s²)
export const SIGMA_RHO = 7.29e-5; // tensión superficial / densidad (m³/s²)

// Número de onda de Faraday para una excitación a f Hz. La superficie
// responde a ω_s = π·f (subarmónica) y k resuelve la dispersión
// gravedad-capilaridad con Newton-Raphson.
export function faradayWavenumber(f) {
  const ws = Math.PI * f; // ω_s = ω_d / 2
  const ws2 = ws * ws;
  // Estimación inicial en la rama dominante: capilar si ω_s² ≫ g·k_c³.
  const kCap = Math.cbrt(ws2 / SIGMA_RHO);
  const kGra = ws2 / G;
  let k = kCap < kGra ? kCap : kGra;
  for (let i = 0; i < 10; i++) {
    const fk = G * k + SIGMA_RHO * k * k * k - ws2;
    const dfk = G + 3 * SIGMA_RHO * k * k;
    let dk = fk / dfk;
    if (dk > k * 0.8) dk = k * 0.8;
    else if (dk < -k * 0.8) dk = -k * 0.8;
    k -= dk;
    if (Math.abs(dk) < k * 1e-6) break;
  }
  return k;
}
