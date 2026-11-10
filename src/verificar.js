// src/verificar.js
// Página /verificar — confirma el correo con el token de un solo uso que
// llegó por email (?token=…). Si hay sesión activa, refresca el perfil para
// que el badge de verificación se actualice.

import { verifyEmail } from './api/auth.js';
import { getAccessToken } from './api/client.js';
import { errorDetail } from './ui/auth.js';

const $ = (id) => document.getElementById(id);

function setState({ title, text, note, actions }) {
  const t = $('verify-title');
  const txt = $('verify-text');
  const noteEl = $('verify-note');
  const actionsEl = $('verify-actions');
  const emoji = document.querySelector('.verify-card .rm-emoji');
  if (t) t.textContent = title;
  if (txt) txt.textContent = text;
  if (noteEl) {
    noteEl.textContent = note || '';
    noteEl.hidden = !note;
  }
  if (actionsEl) {
    actionsEl.innerHTML = '';
    (actions || []).forEach((a) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hero-cta';
      btn.textContent = a.label;
      btn.addEventListener('click', () => {
        if (a.url) window.location.href = a.url;
      });
      actionsEl.appendChild(btn);
    });
  }
  if (emoji) emoji.textContent = (title && title.includes('error')) || /inválido|venció/i.test(text) ? '😕' : '✅';
}

async function run() {
  const params = new URLSearchParams(window.location.search);
  const token = (params.get('token') || '').trim();

  if (!token) {
    setState({
      title: 'Enlace inválido',
      text: 'Falta el código de confirmación en la dirección. Usá el enlace completo que te enviamos por correo.',
      actions: [{ label: 'Ir al generador', url: '/' }],
    });
    return;
  }

  try {
    await verifyEmail(token);
    // Si hay sesión, refrescar el perfil para que email_verified se actualice.
    if (getAccessToken() && window.__vyneuralAuth && typeof window.__vyneuralAuth.refresh === 'function') {
      window.__vyneuralAuth.refresh().catch(() => {});
    }
    setState({
      title: '¡Correo confirmado!',
      text: 'Tu cuenta quedó activada. Ya podés iniciar sesión y sincronizar tus favoritos, frecuencias y rutinas.',
      actions: [
        { label: 'Ir al generador', url: '/' },
        ...(getAccessToken() ? [{ label: 'Ver mi cuenta', url: '/cuenta' }] : []),
      ],
    });
  } catch (err) {
    const status = err && err.status;
    const detail = errorDetail(err, '');
    if (status === 400 && /venció/i.test(detail)) {
      setState({
        title: 'El enlace venció',
        text: 'Este enlace de confirmación ya no es válido (dura 24 horas). Reenviá el correo desde tu cuenta o pedí uno nuevo.',
        actions: [{ label: 'Reenviar desde mi cuenta', url: '/cuenta' }],
      });
    } else {
      setState({
        title: 'No se pudo confirmar',
        text: detail && typeof detail === 'string'
          ? detail
          : 'El enlace no es válido o ya fue usado. Reenviá el correo desde tu cuenta.',
        actions: [{ label: 'Ir a mi cuenta', url: '/cuenta' }],
      });
    }
  }
}

document.addEventListener('DOMContentLoaded', run, { once: true });
