// src/onboarding-flow.js
// Onboarding progresivo — orquestación (evalúa cuándo mostrar qué, carga y
// guarda el estado local, dispara el modal). La lógica pura de "qué hito
// corresponde ahora" vive en src/core/session-milestones.js (no se toca
// acá); este módulo solo decide CUÁNDO evaluar (eventos) y QUÉ hacer con el
// resultado de la interacción del usuario con el modal.

import { getAccessToken } from './api/client.js';
import { getCompletedSessionCount, nextDueStep } from './core/session-milestones.js';
import { getMarketingProfile } from './api/marketing.js';

const LS_STATE = 'vyneural_onboarding_v1';

export function loadState() {
  try {
    const raw = localStorage.getItem(LS_STATE);
    if (!raw) return { answered: {}, skippedAt: {} };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { answered: {}, skippedAt: {} };
    return {
      answered: parsed.answered && typeof parsed.answered === 'object' ? parsed.answered : {},
      skippedAt: parsed.skippedAt && typeof parsed.skippedAt === 'object' ? parsed.skippedAt : {},
    };
  } catch {
    return { answered: {}, skippedAt: {} };
  }
}

export function saveState(state) {
  try {
    localStorage.setItem(LS_STATE, JSON.stringify(state));
  } catch {
    /* localStorage puede lanzar en WebView/modo privado — best-effort, no
       es dato crítico, se pierde solo la persistencia de esta UX puntual. */
  }
}

// Mutex: evita evaluaciones concurrentes si varios eventos (login, sesión
// grabada, resumed) se disparan casi juntos — mismo criterio que
// checkInFlight en src/platform/google-play-redeem.js.
let evaluating = false;

function handleResolved(step, count, result) {
  const state = loadState();
  if (result === 'answered') {
    state.answered[step] = true;
  } else {
    state.skippedAt[step] = { count };
  }
  saveState(state);
}

export async function evaluateOnboarding() {
  if (evaluating) return;
  if (!getAccessToken()) return;
  evaluating = true;
  try {
    const count = getCompletedSessionCount();
    const state = loadState();
    let step = nextDueStep(count, state);
    if (!step) return;

    let profile = null;
    if (step === 'goal' || step === 'content_preferences') {
      try {
        profile = await getMarketingProfile();
      } catch {
        profile = null;
      }
      if (profile) {
        state.answered.goal = !!profile.goal;
        state.answered.content_preferences =
          Array.isArray(profile.content_preferences) && profile.content_preferences.length > 0;
        saveState(state);
        step = nextDueStep(count, state);
        if (!step) return;
      }
    }

    const mod = await import('./ui/onboarding-modal.js');
    mod.showMilestoneStep(step, {
      profile,
      onResolved: (result) => handleResolved(step, count, result),
    });
  } finally {
    evaluating = false;
  }
}

export function initOnboardingFlow() {
  document.addEventListener('vyneural:auth', (e) => {
    if (e.detail?.type !== 'logout') evaluateOnboarding();
  });
  document.addEventListener('vyneural:session-recorded', evaluateOnboarding);
  // Señal nativa de foreground (ver android/.../MainActivity.kt::onResume,
  // pushToWeb dispara este evento) — ya consumida hoy por
  // src/platform/google-play-redeem.js. Acá cubre volver del task switcher
  // tras completar sesiones mientras la app estaba en segundo plano.
  document.addEventListener('vyneural:resumed', evaluateOnboarding);
  if (getAccessToken()) evaluateOnboarding();
}
