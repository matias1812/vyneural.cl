export const MARKETING_GOALS = Object.freeze([
  'relaxation', 'sleep_routine', 'focus_study_work', 'meditation', 'explore_audio',
]);
export const MARKETING_CONTENT_PREFERENCES = Object.freeze([
  'guides_exercises', 'product_updates', 'educational_content', 'offers', 'community',
]);
export const MARKETING_STAGES = Object.freeze([
  'prospect', 'trial', 'active_customer', 'former_customer',
]);

const GOAL_LABELS = Object.freeze({
  relaxation: 'Relajarme',
  sleep_routine: 'Crear una rutina de sueño',
  focus_study_work: 'Concentrarme, estudiar o trabajar',
  meditation: 'Meditar',
  explore_audio: 'Explorar audio y frecuencias',
  learn_product: 'Conocer el producto',
  new_features: 'Descubrir novedades',
  premium_plans: 'Explorar los planes Premium',
  discounts: 'Encontrar descuentos',
  guided_content: 'Recibir contenido guiado',
});

const STAGE_LABELS = Object.freeze({
  prospect: 'Estás explorando Vyneural',
  trial: 'Tienes un período de prueba activo',
  active_customer: 'Tienes un plan activo',
  former_customer: 'Tu plan anterior ya no está activo',
});

export function marketingGoalLabel(goal) {
  return GOAL_LABELS[goal] || null;
}

export function marketingFunnelStageLabel(stage) {
  return STAGE_LABELS[stage] || 'Etapa no disponible';
}

export function marketingProfileUpdatePayload(goal, contentPreferences) {
  return {
    goal: MARKETING_GOALS.includes(goal) || Object.hasOwn(GOAL_LABELS, goal) ? goal : null,
    content_preferences: [...new Set(Array.isArray(contentPreferences) ? contentPreferences : [])]
      .filter((value) => MARKETING_CONTENT_PREFERENCES.includes(value)),
  };
}

export function readMarketingDoiToken(hash) {
  if (typeof hash !== 'string' || !hash.startsWith('#')) return null;
  const tokens = new URLSearchParams(hash.slice(1)).getAll('marketing-doi');
  if (tokens.length !== 1 || !/^[A-Za-z0-9_-]{32,256}$/.test(tokens[0])) return null;
  return tokens[0];
}

export function marketingDoiResultMessage(consentStatus) {
  if (consentStatus === 'confirmed') {
    return { title: 'Suscripción confirmada', text: 'Gracias. Confirmamos tu consentimiento para recibir comunicaciones de Vyneural.' };
  }
  if (consentStatus === 'pending') {
    return { title: 'Confirmación recibida', text: 'Recibimos tu confirmación. La sincronización de tu suscripción está terminando; puede tardar unos instantes.' };
  }
  return { title: 'No se pudo confirmar', text: 'La respuesta del servidor no permitió verificar esta suscripción. Revisa el enlace o contacta a soporte.' };
}

export function marketingDoiCleanUrl(pathname, search = '') {
  return `${pathname || '/'}${search || ''}`;
}

const CONSENT_PRESENTATION = Object.freeze({
  not_requested: {
    label: 'Sin suscripción',
    description: 'No recibes correos de marketing. Si te interesa, puedes solicitar la confirmación.',
    action: 'request',
  },
  awaiting_doi: {
    label: 'Pendiente de verificar correo',
    description: 'Confirma primero el correo de tu cuenta. Después te enviaremos un mensaje separado para confirmar novedades.',
    action: 'wait',
  },
  pending: {
    label: 'Esperando tu confirmación',
    description: 'Revisa tu correo y abre el enlace. En la página de Vyneural, pulsa «Confirmar suscripción» para completar el alta. Hasta entonces no enviaremos campañas.',
    action: 'resend',
  },
  confirmed: {
    label: 'Suscripción confirmada',
    description: 'Recibes las comunicaciones que elegiste. Puedes retirar tu consentimiento cuando quieras.',
    action: 'revoke',
  },
  revoked: {
    label: 'Dado de baja',
    description: 'No recibirás comunicaciones de marketing. Puedes suscribirte otra vez con una nueva confirmación.',
    action: 'request',
  },
  blocked: {
    label: 'Suscripción no disponible',
    description: 'No podemos iniciar una suscripción para esta dirección. Si crees que es un error, contacta a soporte.',
    action: 'none',
  },
});

export function marketingConsentPresentation(profile) {
  const status = CONSENT_PRESENTATION[profile?.consent_status]
    ? profile.consent_status
    : 'not_requested';
  const view = CONSENT_PRESENTATION[status];
  return {
    status,
    ...view,
    visible: status !== 'blocked' && !(status === 'awaiting_doi' && profile?.email_verified !== true),
    disabled: status === 'blocked' || (profile?.consent_configured === false && status !== 'confirmed'),
    description: profile?.consent_configured === false && status !== 'confirmed' && status !== 'blocked'
      ? `${view.description} La suscripción estará disponible cuando el servicio de correo quede configurado.`
      : view.description,
  };
}
