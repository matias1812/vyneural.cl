// src/pago-retorno.js
// Página /pago-retorno — a donde el BACKEND redirige (302/303) después de
// confirmar (o no) un pago de Webpay con Transbank (ver
// backvyneural/backend/app/routers/payments.py::commit_payment). El backend
// ya hizo todo el trabajo real antes de redirigir acá: esta página solo lee
// `?status=` y muestra el resultado — no llama a ningún endpoint.

const $ = (id) => document.getElementById(id);

const MESSAGES = {
  approved: {
    emoji: '✅',
    title: '¡Pago aprobado!',
    text: 'Tu plan Premium ya está activo. Podés ver el detalle y la fecha de vencimiento en tu cuenta.',
    actions: [{ label: 'Ver mi cuenta', url: '/cuenta' }],
  },
  rejected: {
    emoji: '😕',
    title: 'El pago no se pudo procesar',
    text: 'Transbank rechazó el pago (fondos insuficientes, tarjeta no habilitada u otro motivo del banco emisor). No se hizo ningún cargo.',
    actions: [{ label: 'Volver a intentar', url: '/premium' }],
  },
  cancelled: {
    emoji: '↩️',
    title: 'Pago cancelado',
    text: 'Cancelaste el pago antes de terminarlo. No se hizo ningún cargo.',
    actions: [{ label: 'Volver a los planes', url: '/premium' }],
  },
  error: {
    emoji: '⚠️',
    title: 'Algo salió mal',
    text: 'No pudimos confirmar el resultado de tu pago. Si te cobraron y no ves el plan activo en tu cuenta en unos minutos, escribinos usando la burbuja 🐞 de reportes.',
    actions: [
      { label: 'Ver mi cuenta', url: '/cuenta' },
      { label: 'Volver a los planes', url: '/premium' },
    ],
  },
};

function render(status) {
  const info = MESSAGES[status] || MESSAGES.error;
  const emoji = document.querySelector('.verify-card .rm-emoji');
  if (emoji) emoji.textContent = info.emoji;
  $('pago-title').textContent = info.title;
  $('pago-text').textContent = info.text;
  const actionsEl = $('pago-actions');
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
