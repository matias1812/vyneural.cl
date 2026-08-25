// ── Comentarios y ranking (backend opcional, aditivo) ───────────────────────
// La sección se muestra al final de la página principal. Sin backend o sin
// sesión, todo es aditivo: la web sigue funcionando igual.
//
// Carga: el GET usa cachedGet (TTL 8 s + dedup en vuelo), igual que el resto
// de la API — no se re-pide en cada navegación.
// Seguridad: contenido y autores van escapados (nunca innerHTML sin escape).

import { post, cachedGet, invalidateCache } from './api/client.js';

const LS_COMMENTS = 'vyneural_comments_mine';

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function $(id) {
  return document.getElementById(id);
}

// ── Estado de la sección ────────────────────────────────────────────────────

let rating = 0; // estrellas elegidas en el formulario
let listEl = null;
let formEl = null;

function isLoggedIn() {
  return !!(window.__vyneuralAuth && window.__vyneuralAuth.isLoggedIn());
}

function renderAuthHint() {
  const hint = $('comments-auth-hint');
  if (!hint) return;
  if (isLoggedIn()) {
    hint.textContent = '';
  } else {
    hint.textContent = 'Para comentar necesitás una cuenta (gratis y opcional).';
  }
}

function starsHTML(rating) {
  const r = Math.round(rating || 0);
  let out = '';
  for (let i = 1; i <= 5; i++) {
    out += `<span class="c-star-static${i <= r ? ' on' : ''}" aria-hidden="true">★</span>`;
  }
  return out;
}

function barsHTML(summary) {
  const dist = summary.distribution || {};
  const total = summary.total || 0;
  let out = '';
  for (let r = 5; r >= 1; r--) {
    const n = dist[String(r)] || 0;
    const pct = total > 0 ? Math.round((n / total) * 100) : 0;
    out += `<div class="comments-bar-row">
        <span class="comments-bar-label">${r}★</span>
        <div class="comments-bar-track"><div class="comments-bar-fill" style="width:${pct}%"></div></div>
        <span class="comments-bar-n">${n}</span>
      </div>`;
  }
  return out;
}

function renderRanking(summary) {
  const rank = $('comments-rank');
  if (!rank || !summary || !summary.total) {
    if (rank) rank.hidden = true;
    return;
  }
  rank.hidden = false;
  const avg = $('comments-average');
  const stars = $('comments-stars');
  const total = $('comments-total');
  const bars = $('comments-bars');
  if (avg) avg.textContent = summary.average.toFixed(1);
  if (stars) stars.innerHTML = starsHTML(summary.average);
  if (total) total.textContent = `${summary.total} valoración${summary.total === 1 ? '' : 'es'}`;
  if (bars) bars.innerHTML = barsHTML(summary);
}

function renderList(items) {
  if (!listEl) return;
  listEl.innerHTML = '';
  const empty = $('comments-empty');
  const has = items && items.length > 0;
  if (empty) empty.hidden = has;
  (items || []).forEach((c) => {
    const li = document.createElement('li');
    li.className = 'comment-item';
    li.innerHTML = `
      <div class="comment-head">
        <span class="comment-avatar" aria-hidden="true">${escapeHtml((c.author || '?').slice(0, 1).toUpperCase())}</span>
        <span class="comment-author">${escapeHtml(c.author || 'Anónimo')}</span>
        <span class="comment-stars-mini" aria-label="${c.rating} de 5">${starsHTML(c.rating)}</span>
        <span class="comment-date">${escapeHtml(fmtDate(c.created_at))}</span>
      </div>
      <p class="comment-text">${escapeHtml(c.content)}</p>`;
    listEl.appendChild(li);
  });
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch (_) {
    return '';
  }
}

// ── Carga (caché TTL + dedup, aditiva) ──────────────────────────────────────

async function fetchComments() {
  const data = await cachedGet('/api/v1/comments?per_page=10', 8000);
  renderRanking(data && data.summary);
  renderList(data && data.items);
}

function showCommentsUnavailable() {
  // Sin backend: ocultar el ranking y dejar el formulario con el aviso.
  renderRanking(null);
  renderList([]);
  const hint = $('comments-auth-hint');
  if (hint && !isLoggedIn()) {
    hint.textContent = 'Comentarios no disponibles sin conexión al servidor.';
  }
}

async function loadComments() {
  try {
    await fetchComments();
  } catch (_) {
    showCommentsUnavailable();
  }
}

// Solo para el arranque (init()): un cold start de Render (20-50s) hacía
// que el ÚNICO intento de loadComments() de la carga de página fallara con
// un error de red — transitorio, no "no hay comentarios". Sin reintentos,
// la sección quedaba vacía (o con el aviso "sin conexión") para siempre en
// esa carga de página, aunque el backend respondiera segundos después —
// mismo bug y mismo fix que refreshProfileOnBoot() en ui/auth.js. Recién
// se muestra el aviso de "no disponible" si se agotan los reintentos, para
// no mostrar un mensaje alarmante de más durante un cold start normal.
//
// Presupuesto extendido (ver mismo cambio en ui/auth.js y cuenta.js):
// reportado en vivo un caso real de ~5 min sin resolver en la APK, por
// encima de los ~41s originales.
async function loadCommentsOnBoot() {
  const RETRY_DELAYS_MS = [
    3000, 6000, 12000, 20000, // ~41s — cold start "típico"
    30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000, // +270s — cold start largo
  ]; // ~5m11s de cobertura total
  for (let attempt = 0; ; attempt++) {
    try {
      await fetchComments();
      return;
    } catch (_) {
      if (attempt >= RETRY_DELAYS_MS.length) {
        showCommentsUnavailable();
        return;
      }
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
}

// ── Formulario ──────────────────────────────────────────────────────────────

function showError(msg) {
  const err = $('comments-error');
  const ok = $('comments-ok');
  if (err) {
    err.textContent = msg;
    err.classList.remove('hidden');
  }
  if (ok) ok.classList.add('hidden');
}

function showOk(msg) {
  const err = $('comments-error');
  const ok = $('comments-ok');
  if (err) err.classList.add('hidden');
  if (ok) {
    ok.textContent = msg;
    ok.classList.remove('hidden');
  }
}

async function submitComment(e) {
  e.preventDefault();
  const text = $('comments-text');
  const content = (text && text.value.trim()) || '';
  if (content.length < 3) {
    showError('El comentario debe tener al menos 3 caracteres.');
    return;
  }
  if (!rating) {
    showError('Elegí una valoración de 1 a 5 estrellas.');
    return;
  }
  if (!isLoggedIn()) {
    showError('Necesitás iniciar sesión para comentar.');
    if (window.__vyneuralAuth && typeof window.__vyneuralAuth.open === 'function') {
      window.__vyneuralAuth.open('login');
    }
    return;
  }
  const btn = $('comments-submit');
  if (btn) btn.disabled = true;
  try {
    await post('/api/v1/comments', { content, rating });
    showOk('¡Gracias por tu valoración! Ya aparece en el ranking. ✓');
    if (text) text.value = '';
    rating = 0;
    paintStars();
    // Invalidar el caché para que la lista salga fresca ya mismo.
    invalidateCache('/api/v1/comments');
    loadComments();
  } catch (err) {
    const detail = err && err.detail ? err.detail : 'No se pudo publicar el comentario.';
    showError(detail);
    // Correo sin verificar: el backend devuelve 403 con la explicación.
    if (err && err.status === 401) {
      if (window.__vyneuralAuth && typeof window.__vyneuralAuth.open === 'function') {
        window.__vyneuralAuth.open('login');
      }
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

function paintStars() {
  document.querySelectorAll('#comments-star-input .c-star').forEach((b) => {
    const r = Number(b.dataset.r);
    const on = r <= rating;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

function wireForm() {
  formEl = $('comments-form');
  if (!formEl) return;
  const box = $('comments-star-input');
  if (box) {
    box.addEventListener('click', (e) => {
      const star = e.target.closest('.c-star');
      if (!star) return;
      rating = Number(star.dataset.r);
      paintStars();
    });
  }
  formEl.addEventListener('submit', submitComment);
  renderAuthHint();
}

// ── Arranque ────────────────────────────────────────────────────────────────

function init() {
  listEl = $('comments-list');
  wireForm();
  loadCommentsOnBoot();
  document.addEventListener('vyneural:auth', () => {
    renderAuthHint();
    loadComments();
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}
