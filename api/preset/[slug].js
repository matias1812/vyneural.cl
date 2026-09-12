// api/preset/[slug].js — Vercel Edge Function.
//
// Intercepta /preset/:slug (ver el rewrite en vercel.json) y sirve el MISMO
// index.html estático de siempre, pero con las metaetiquetas reescritas
// según el preset. La SPA sigue siendo la SPA: esto no es SSR de contenido,
// solo de <head> — el resto se hidrata en el cliente como siempre (ver el
// bloque "Deep link limpio" en src/main.js).
//
// Por qué reescribir el HTML acá y no en el build: los slugs numéricos
// (`245-15-sine`) son ilimitados — no se pueden pre-renderizar como páginas
// estáticas sin explotar el número de archivos. Los curados sí podrían
// pre-renderizarse, pero mantenerlos en el mismo camino que los numéricos
// evita dos sistemas de metaetiquetas en paralelo que puedan divergir.
//
// runtime: 'edge' porque HTMLRewriter (streaming, no reparsea el documento
// completo) solo está disponible ahí — en Node "serverless" normal habría
// que usar el fallback por regex de abajo.

import { resolvePresetSlug } from '../../shared/preset-catalog.js';

export const config = { runtime: 'edge' };

const SITE = 'https://www.vyneural.cl';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default async function handler(request) {
  const url = new URL(request.url);
  const slugParam = url.pathname.split('/').filter(Boolean).pop();
  const preset = resolvePresetSlug(decodeURIComponent(slugParam || ''));

  // El propio index.html estático, servido por el CDN de este mismo deploy
  // — así el HTML base (nav, footer, JSON-LD del sitio, etc.) nunca se
  // duplica ni se desincroniza del que ve cualquier otra página.
  const shellRes = await fetch(new URL('/index.html', url.origin));
  if (!shellRes.ok) {
    return new Response('Not found', { status: 404 });
  }

  // Slug desconocido (ni curado ni con forma de preset personalizado): se
  // sirve la SPA igual (el cliente decide qué mostrar), pero nunca indexado.
  if (!preset) {
    return new HTMLRewriter()
      .on('head', {
        element(el) {
          el.append('<base href="/">', { html: true });
        },
      })
      .on('meta[name="robots"]', {
        element(el) {
          el.setAttribute('content', 'noindex, follow');
        },
      })
      .transform(shellRes);
  }

  const title = escapeHtml(`${preset.title} | Vyneural`);
  const description = escapeHtml(preset.description);
  const canonical = `${SITE}/preset/${preset.slug}`;
  const robots = preset.indexable ? 'index, follow' : 'noindex, follow';

  const rewritten = new HTMLRewriter()
    .on('head', {
      element(el) {
        // `vite.config.js` usa base:'./' para que la APK cargue desde
        // file:// (ver CLAUDE.md) — TODO el HTML compilado referencia sus
        // assets con rutas relativas ("./assets/main-xxx.js"). Servido tal
        // cual en /preset/:slug, esas rutas relativas se resuelven contra
        // ESE path y rompen (404 en JS/CSS, página en blanco). <base> las
        // vuelve a anclar en la raíz sin tocar el build real de la APK.
        el.append('<base href="/">', { html: true });
      },
    })
    .on('title', {
      element(el) {
        el.setInnerContent(title);
      },
    })
    .on('meta[name="description"]', {
      element(el) {
        el.setAttribute('content', description);
      },
    })
    .on('meta[name="robots"]', {
      element(el) {
        el.setAttribute('content', robots);
      },
    })
    .on('link[rel="canonical"]', {
      element(el) {
        el.setAttribute('href', canonical);
      },
    })
    .on('meta[property="og:title"]', {
      element(el) {
        el.setAttribute('content', title);
      },
    })
    .on('meta[property="og:description"]', {
      element(el) {
        el.setAttribute('content', description);
      },
    })
    .on('meta[property="og:url"]', {
      element(el) {
        el.setAttribute('content', canonical);
      },
    })
    .on('meta[name="twitter:title"]', {
      element(el) {
        el.setAttribute('content', title);
      },
    })
    .on('meta[name="twitter:description"]', {
      element(el) {
        el.setAttribute('content', description);
      },
    })
    .transform(shellRes);

  return new Response(rewritten.body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Los curados cambian poco: cache larga en el edge. Los numéricos son
      // ilimitados y casi siempre de una sola visita — cache corta para no
      // llenar la cache del edge con millones de variantes de un solo uso.
      'cache-control': preset.indexable
        ? 'public, max-age=300, s-maxage=86400, stale-while-revalidate=3600'
        : 'public, max-age=60, s-maxage=300',
    },
  });
}
