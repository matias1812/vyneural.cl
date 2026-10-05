import './site.css';
import { confirmMarketingDoi } from './api/marketing.js';
import { marketingDoiCleanUrl, marketingDoiResultMessage, readMarketingDoiToken } from './marketing-ui.js';

const title = document.getElementById('doi-title');
const copy = document.getElementById('doi-copy');
const status = document.getElementById('doi-status');
const button = document.getElementById('doi-confirm');
const icon = document.getElementById('doi-icon');
let token = readMarketingDoiToken(window.location.hash);

function showInvalidLink() {
  title.textContent = 'Enlace inválido';
  copy.textContent = 'No encontramos un código de confirmación válido en este enlace. Abre el enlace completo que te enviamos por correo.';
  icon.textContent = '⚠️';
  button.hidden = true;
}

if (!token) {
  showInvalidLink();
} else {
  title.textContent = 'Confirma tu suscripción';
  copy.textContent = 'Al confirmar, aceptas recibir comunicaciones de Vyneural. Esta elección es voluntaria y podrás darte de baja desde Mi cuenta.';
  button.hidden = false;
  button.addEventListener('click', async () => {
    if (!token || button.disabled) return;
    button.disabled = true;
    status.textContent = 'Confirmando…';
    // El fragment nunca viaja al servidor. Se elimina del historial visible
    // justo después del gesto; el token queda solo en memoria para reintentar
    // si hay un error temporal de red.
    window.history.replaceState(window.history.state, '', marketingDoiCleanUrl(window.location.pathname, window.location.search));
    try {
      const result = await confirmMarketingDoi(token);
      token = null;
      const message = marketingDoiResultMessage(result?.consent_status);
      title.textContent = message.title;
      copy.textContent = message.text;
      status.textContent = '';
      icon.textContent = result?.consent_status === 'confirmed' || result?.consent_status === 'pending' ? '✅' : '⚠️';
      button.hidden = true;
    } catch (error) {
      status.textContent = error?.detail || 'No pudimos completar la solicitud. Comprueba tu conexión y vuelve a intentarlo.';
      button.disabled = false;
    }
  });
}
