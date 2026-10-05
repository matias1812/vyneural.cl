// Perfil y encuestas son endpoints first-party autenticados; solo la
// confirmación DOI es pública y se invoca con gesto explícito. Nunca llamamos
// a Brevo desde el navegador ni exponemos credenciales de proveedor.
import { API_BASE, get, patch, post, del } from './client.js';

export const getMarketingProfile = () => get('/api/v1/marketing/profile');
export const updateMarketingProfile = (body) => patch('/api/v1/marketing/profile', body);
export const requestMarketingConsent = (source = 'account') =>
  post('/api/v1/marketing/consent', { consent: true, source });
export const revokeMarketingConsent = () => del('/api/v1/marketing/consent');
export const submitMarketingSurvey = (body) => post('/api/v1/marketing/surveys', body);

// El token DOI llega en el fragmento del enlace y se envía solo en el body
// tras una acción explícita. Esta confirmación es pública y no usa la sesión
// del usuario ni cookies.
export async function confirmMarketingDoi(token) {
  const response = await fetch(`${API_BASE}/api/v1/marketing/confirm-doi`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  let data = null;
  try {
    data = await response.json();
  } catch (_) {
    // La respuesta de error puede no ser JSON; se normaliza abajo.
  }
  if (!response.ok) {
    const error = new Error(data?.detail || 'No se pudo confirmar la suscripción.');
    error.status = response.status;
    error.detail = data?.detail;
    throw error;
  }
  return data;
}
