// scripts/check-deploy.mjs
// Chequeo de despliegue de Vyneural (Web + API + correo).
// Uso:
//   node scripts/check-deploy.mjs
//   node scripts/check-deploy.mjs --email vos@ejemplo.com
//   node scripts/check-deploy.mjs --frontend https://www.vyneural.cl --backend https://vyneural-backend.onrender.com
//
// Verifica, sin modificar nada:
//   1. Backend /health y /health/db (servicio + PostgreSQL).
//   2. /docs (la app FastAPI correcta, no un 404).
//   3. Rewrite del frontend: /api/... debe responder el backend (no el 404 de Vercel).
//   4. CORS: la API debe admitir el origen del frontend.
//   5. (Opcional, --email) dispara forgot-password → el correo DEBE llegar a esa
//      bandeja (revisar spam). La respuesta es genérica a propósito.

const FRONTEND = process.env.FRONTEND_URL || 'https://www.vyneural.cl';
const BACKEND = process.env.BACKEND_URL || 'https://vyneural-backend.onrender.com';

const args = process.argv.slice(2);
const emailArg = args.find((a) => a.startsWith('--email='))?.split('=')[1]
  || (args.includes('--email') ? args[args.indexOf('--email') + 1] : null);

let failed = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.error(`  ✗ ${m}`); failed += 1; };

async function getJson(url, { headers = {}, method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* sin cuerpo JSON */ }
  return { res, json };
}

async function main() {
  console.log(`\n=== Vyneural deploy check ===`);
  console.log(`Frontend: ${FRONTEND}`);
  console.log(`Backend : ${BACKEND}\n`);

  // 1) Backend vivo + DB
  console.log('1) Backend /health');
  try {
    const { res, json } = await getJson(`${BACKEND}/health`);
    if (res.status === 200 && json?.status === 'ok') ok(`/health 200 (${json.service || 'vyneural'})`);
    else bad(`/health → HTTP ${res.status} ${JSON.stringify(json || '')}`);
  } catch (e) {
    bad(`/health inalcanzable: ${e.message}`);
  }

  console.log('   /health/db');
  try {
    const { res, json } = await getJson(`${BACKEND}/health/db`);
    if (res.status === 200 && json?.database === 'ok') ok(`/health/db 200 (PostgreSQL ok)`);
    else bad(`/health/db → HTTP ${res.status} ${JSON.stringify(json || '')}`);
  } catch (e) {
    bad(`/health/db inalcanzable: ${e.message}`);
  }

  // 2) /docs — confirma que es la app FastAPI correcta
  console.log('2) /docs');
  try {
    const res = await fetch(`${BACKEND}/docs`);
    if (res.status === 200) ok(`/docs 200 (FastAPI)`);
    else bad(`/docs → HTTP ${res.status}`);
  } catch (e) {
    bad(`/docs inalcanzable: ${e.message}`);
  }

  // 3) Rewrite del frontend: /api debe pasar al backend (401 "no autorizado"
  //    del FastAPI = rewrite activo; el 404 con página de Vercel = NO publicado)
  console.log('3) Rewrite /api del frontend');
  try {
    const { res, json } = await getJson(`${FRONTEND}/api/v1/auth/me`);
    if (res.status === 401 && json?.detail === 'no autorizado') {
      ok(`/api/v1/auth/me → 401 del backend (rewrite activo; auth funcionando)`);
    } else if (res.status === 401) {
      ok(`/api responde 401 del backend (rewrite activo)`);
    } else if (res.status === 404) {
      bad('HTTP 404 con página de Vercel → el rewrite de /api NO está publicado. Commitear y desplegar vercel.json (o setear VITE_API_URL).');
    } else {
      bad(`/api → HTTP ${res.status} (¿backend caído o en cold start?)`);
    }
  } catch (e) {
    bad(`/api del frontend inalcanzable: ${e.message}`);
  }

  // 4) CORS
  console.log('4) CORS');
  try {
    const { res } = await getJson(`${BACKEND}/api/v1/auth/me`, {
      headers: { Origin: FRONTEND },
    });
    const acao = res.headers.get('access-control-allow-origin');
    if (res.status === 401 && acao === FRONTEND) {
      ok(`CORS ok: Access-Control-Allow-Origin = ${acao} (401 esperado sin token)`);
    } else if (acao === FRONTEND) {
      ok(`CORS ok: ${acao} (HTTP ${res.status})`);
    } else {
      bad(`CORS: Access-Control-Allow-Origin = ${acao || '(ausente)'} (esperado ${FRONTEND}) — revisar CORS_ORIGINS en Render`);
    }
  } catch (e) {
    bad(`CORS inalcanzable: ${e.message}`);
  }

  // 5) Proveedor de correo (health/email): config + autenticación real del relay
  console.log('5) Proveedor de correo');
  try {
    const { res, json } = await getJson(`${BACKEND}/health/email`);
    if (res.status === 200 && json) {
      const test = await getJson(`${BACKEND}/health/email?test=1`).catch(() => ({ json: null }));
      const t = (test && test.json) || {};
      const auth = t.auth_ok === true
        ? 'autenticación SMTP/API OK ✓'
        : t.error_kind === 'throttled'
          ? 'prueba limitada (reintentar en 30 s)'
          : t.error_kind
            ? `falla (${t.error_kind}: ${t.error_detail || 'sin detalle'}) — si es smtp+free tier, Render bloquea 25/465/587; usar EMAIL_PROVIDER=resend|brevo`
            : 'sin probar';
      ok(`provider=${json.provider} · configured=${json.configured} · api_key_set=${json.api_key_set} · ${auth}`);
    } else {
      bad(`/health/email → HTTP ${res.status}`);
    }
  } catch (e) {
    bad(`/health/email inalcanzable: ${e.message}`);
  }

  // 6) Correo (opcional)
  if (emailArg) {
    console.log('6) Correo (forgot-password)');
    try {
      const { res, json } = await getJson(`${BACKEND}/api/v1/auth/forgot-password`, {
        method: 'POST',
        body: { email: emailArg },
      });
      if (res.status === 200 && /si el correo existe/i.test(json?.detail || '')) {
        ok(`forgot-password → 200. Si ${emailArg} está registrado, el correo debe llegar a esa bandeja (revisar spam).`);
      } else {
        bad(`forgot-password → HTTP ${res.status} ${JSON.stringify(json || '')}`);
      }
    } catch (e) {
      bad(`forgot-password inalcanzable: ${e.message}`);
    }
  } else {
    console.log('6) Correo: omitido (pasá --email vos@ejemplo.com para probar el envío real)');
  }

  console.log(failed === 0
    ? '\n✓ TODO OK — despliegue verificado.\n'
    : `\n✗ ${failed} chequeo(s) fallaron. Ver docs/DEPLOY_VARIABLES.md.\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
