// scripts/generate-sitemap.mjs
// Fuente de verdad única para public/sitemap.xml: combina la lista de
// páginas estáticas del sitio con los slugs indexables de
// shared/preset-catalog.js (los numéricos, ej. "245-15-sine", NUNCA entran
// acá — son ilimitados y deliberadamente noindex, ver ese archivo). Antes
// de este script el sitemap se editaba a mano; agregar un preset curado al
// catálogo ahora lo da de alta acá solo con correr esto, sin tocar XML.
//
// Uso:  node scripts/generate-sitemap.mjs
// Correr después de agregar/quitar una página o un preset curado, antes de
// desplegar (o como paso de CI/prebuild).

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { listIndexablePresetSlugs } from '../shared/preset-catalog.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outPath = path.join(root, 'public', 'sitemap.xml');
const SITE = 'https://www.vyneural.cl';

// Páginas estáticas del sitio (fuera de /preset/*). Si agregas una página
// nueva (como estudiar.html/dormir.html/etc.), agrégala acá también.
const STATIC_PAGES = [
  { loc: '/', changefreq: 'weekly', priority: '1.0' },
  { loc: '/que-son-las-ondas-binaurales', changefreq: 'monthly', priority: '0.9' },
  { loc: '/beneficios', changefreq: 'monthly', priority: '0.9' },
  { loc: '/estudiar', changefreq: 'monthly', priority: '0.8' },
  { loc: '/dormir', changefreq: 'monthly', priority: '0.8' },
  { loc: '/meditar', changefreq: 'monthly', priority: '0.8' },
  { loc: '/solfeggio', changefreq: 'monthly', priority: '0.8' },
  { loc: '/como-usar', changefreq: 'monthly', priority: '0.8' },
  { loc: '/rutina', changefreq: 'weekly', priority: '0.7' },
  { loc: '/hoja-de-ruta', changefreq: 'monthly', priority: '0.5' },
  { loc: '/sobre-nosotros', changefreq: 'yearly', priority: '0.6' },
  { loc: '/privacidad', changefreq: 'yearly', priority: '0.3' },
  { loc: '/descargar', changefreq: 'monthly', priority: '0.7' },
  { loc: '/codigo-abierto', changefreq: 'monthly', priority: '0.6' },
  { loc: '/cuenta', changefreq: 'weekly', priority: '0.6' },
  { loc: '/preguntas-frecuentes', changefreq: 'monthly', priority: '0.7' },
  { loc: '/terminos', changefreq: 'yearly', priority: '0.3' },
  { loc: '/aviso-medico', changefreq: 'yearly', priority: '0.3' },
  { loc: '/cookies', changefreq: 'yearly', priority: '0.3' },
];

const presetEntries = listIndexablePresetSlugs().map((slug) => ({
  loc: `/preset/${slug}`,
  changefreq: 'monthly',
  priority: '0.6',
}));

const entries = [...STATIC_PAGES, ...presetEntries];

const body = entries
  .map(
    (e) => `  <url>
    <loc>${SITE}${e.loc}</loc>
    <changefreq>${e.changefreq}</changefreq>
    <priority>${e.priority}</priority>
  </url>`
  )
  .join('\n');

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;

writeFileSync(outPath, xml, 'utf8');
console.log(`✓ sitemap.xml generado: ${entries.length} URLs (${presetEntries.length} presets curados)`);
