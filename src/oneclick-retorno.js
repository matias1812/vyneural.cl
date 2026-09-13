// src/oneclick-retorno.js
// Página /oneclick-retorno — a donde el BACKEND redirige (303) después de
// confirmar (o no) la inscripción de tarjeta para auto-renovación (ver
// backvyneural/backend/app/routers/payments.py::oneclick_finish). El
// backend ya hizo todo el trabajo real antes de redirigir acá: esta página
// solo lee `?status=` y muestra el resultado — no llama a ningún endpoint.
// Mismo molde que src/pago-retorno.js.

const $ = (id) => document.getElementById(id);

const MESSAGES = {
  approved: {
    emoji: '✅',
    title: '¡Tarjeta inscripta!',
    text: 'La auto-renovación ya está activa. Tu plan se va a renovar solo antes de vencer.',
    actions: [{ label: 'Ver mi cuenta', url: '/cuenta' }],
  },
  rejected: {
    emoji: '😕',
    title: 'No pudimos inscribir tu tarjeta',
    text: 'Transbank rechazó la inscripción (tarjeta no habilitada u otro motivo del banco emisor). Tu plan sigue como estaba, con renovación manual.',
    actions: [{ label: 'Volver a intentar', url: '/cuenta' }],
  },
  cancelled: {
    emoji: '↩️',
    title: 'Inscripción cancelada',
    text: 'Cancelaste la inscripción antes de terminarla. Tu plan sigue como estaba, con renovación manual.',
    actions: [{ label: 'Volver a mi cuenta', url: '/cuenta' }],
  },
  error: {
    emoji: '⚠️',
    title: 'Algo salió mal',
    text: 'No pudimos confirmar el resultado de la inscripción. Si el problema sigue, escribinos usando la burbuja 🐞 de reportes.',
    actions: [{ label: 'Ver mi cuenta', url: '/cuenta' }],
  },
};

function render(status) {
  const info = MESSAGES[status] || MESSAGES.error;
  const emoji = document.querySelector('.verify-card .rm-emoji');
  if (emoji) emoji.textContent = info.emoji;
  $('oc-title').textContent = info.title;
  $('oc-text').textContent = info.text;
  const actionsEl = $('oc-actions');
  actionsEl.innerHTML = '';
  info.actions.forEach((a, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = i === 0 ? 'hero-cta' : 'hero-cta hero-cta-ghost';
    btn.textContent = a.label;
    btn.addEventListener('click', () => {
      window.location.href = a.url;
    });
    actionsEl.appendChild(btn);
  });
}

function run() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get('status') || 'error';
  render(MESSAGES[status] ? status : 'error');
}

document.addEventListener('DOMContentLoaded', run, { once: true });
