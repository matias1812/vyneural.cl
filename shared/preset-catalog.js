// shared/preset-catalog.js
//
// Fuente de verdad ÚNICA para /preset/:slug — la importan tanto
// api/preset/[slug].js (Edge Function, SSR de metaetiquetas) como
// src/main.js (cliente, hidratación del sintetizador). Un solo lugar evita
// que el <title>/<meta description> que ve Google diverja de lo que el
// generador realmente reproduce al cargar.
//
// Dos categorías de slug, con implicancia de indexabilidad DISTINTA:
//
// 1. CURATED_PRESETS — combinaciones fijas y elegidas a mano (estado real de
//    profiles.js, opcionalmente + familia de portadora). Finitas, con copy
//    propio: se indexan (robots: index) y entran al sitemap.
// 2. Slugs numéricos "<base>-<beat>-<wave>" (p. ej. "245-15-sine") — genera
//    esta forma cualquier frecuencia personalizada que un usuario comparta.
//    Son ilimitados por diseño, así que NUNCA se indexan (robots: noindex):
//    el link funciona y muestra una vista previa social correcta, pero no
//    se generan como "doorway pages" a escala — el mismo riesgo de SEO que
//    ya evitamos en /estudiar, /dormir, /meditar, /solfeggio.
//
// Los ids (`stateId`, `carrier`) son los mismos de src/models/profiles.js y
// src/core/carrier.js — no se duplican los valores de Hz acá; el cliente los
// deriva del estado real al aplicar el preset.

export const CURATED_PRESETS = {
  'alfa-10hz-relajacion': {
    stateId: 'relajacion',
    carrier: null,
    title: 'Preset Relajación · Alfa 10 Hz',
    description:
      'Ondas Alfa (10 Hz) sobre portadora de 200 Hz para reducir el estrés del día, generadas en tiempo real.',
  },
  'beta-15hz-estudio': {
    stateId: 'estudio',
    carrier: null,
    title: 'Preset Estudio · Beta 15 Hz',
    description:
      'Ondas Beta (15 Hz) sobre portadora de 245 Hz para sostener el foco en sesiones de estudio.',
  },
  'theta-6hz-meditacion': {
    stateId: 'meditacion',
    carrier: null,
    title: 'Preset Meditación · Theta 6 Hz',
    description:
      'Ondas Theta (6 Hz) sobre portadora de 210 Hz para calmar la mente y entrar en meditación profunda.',
  },
  'delta-2hz-sueno': {
    stateId: 'sueno',
    carrier: null,
    title: 'Preset Sueño Profundo · Delta 2 Hz',
    description:
      'Ondas Delta (2 Hz) sobre portadora de 170 Hz para conciliar el sueño y descansar profundo.',
  },
  'schumann-7-83hz': {
    stateId: 'schumann',
    carrier: null,
    title: 'Preset Resonancia Schumann · 7,83 Hz',
    description:
      'La frecuencia de la Tierra (7,83 Hz) sobre portadora de 190 Hz, para calma y conexión.',
  },
  'solfeggio-528hz-meditacion': {
    stateId: 'meditacion',
    carrier: 'solfeggio',
    title: 'Preset Meditación · Solfeggio 528 Hz',
    description:
      'Ritmo Theta de meditación reafinado a la portadora Solfeggio de 528 Hz, generado en tiempo real.',
  },
  'solfeggio-528hz-relajacion': {
    stateId: 'relajacion',
    carrier: 'solfeggio',
    title: 'Preset Relajación · Solfeggio 528 Hz',
    description:
      'Ritmo Alfa de relajación reafinado a la portadora Solfeggio de 528 Hz, generado en tiempo real.',
  },
};

const CUSTOM_SLUG_RE = /^([0-9]+(?:\.[0-9]+)?)-([0-9]+(?:\.[0-9]+)?)-(sine|triangle|square|sawtooth)$/;

// Resuelve un slug de /preset/:slug a sus parámetros. Devuelve null si el
// slug no matchea nada conocido (la ruta debe tratarse como no encontrada).
export function resolvePresetSlug(rawSlug) {
  const slug = String(rawSlug || '').toLowerCase();
  if (CURATED_PRESETS[slug]) {
    return { slug, indexable: true, ...CURATED_PRESETS[slug] };
  }
  const m = CUSTOM_SLUG_RE.exec(slug);
  if (m) {
    const [, base, beat, wave] = m;
    return {
      slug,
      indexable: false,
      stateId: null,
      carrier: null,
      customBase: Number(base),
      customBeat: Number(beat),
      wave,
      title: `Preset personalizado · ${base} Hz / ${beat} Hz`,
      description: `Preset binaural personalizado: portadora ${base} Hz, ritmo ${beat} Hz, onda ${wave}.`,
    };
  }
  return null;
}

// Lista de slugs indexables — la usa scripts/generate-sitemap.mjs. Vive acá
// (no en el script) para que agregar un preset al catálogo lo dé de alta en
// el sitemap automáticamente, sin tocar dos archivos.
export function listIndexablePresetSlugs() {
  return Object.keys(CURATED_PRESETS);
}
