import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MARKETING_GOALS, MARKETING_CONTENT_PREFERENCES, MARKETING_STAGES,
  marketingConsentPresentation, readMarketingDoiToken, marketingDoiCleanUrl,
  marketingDoiResultMessage, marketingGoalLabel, marketingFunnelStageLabel,
  marketingProfileUpdatePayload,
} from '../src/marketing-ui.js';

test('perfil usa las opciones exactas del contrato de marketing', () => {
  assert.deepEqual(MARKETING_GOALS, ['relaxation', 'sleep_routine', 'focus_study_work', 'meditation', 'explore_audio']);
  assert.deepEqual(MARKETING_CONTENT_PREFERENCES, ['guides_exercises', 'product_updates', 'educational_content', 'offers', 'community']);
  assert.deepEqual(MARKETING_STAGES, ['prospect', 'trial', 'active_customer', 'former_customer']);
  assert.equal(marketingGoalLabel('guided_content'), 'Recibir contenido guiado');
  assert.equal(marketingGoalLabel('unknown'), null);
});

test('etapa del embudo solo se presenta como dato derivado de solo lectura', () => {
  assert.equal(marketingFunnelStageLabel('prospect'), 'Estás explorando Vyneural');
  assert.equal(marketingFunnelStageLabel('trial'), 'Tienes un período de prueba activo');
  assert.equal(marketingFunnelStageLabel('active_customer'), 'Tienes un plan activo');
  assert.equal(marketingFunnelStageLabel('former_customer'), 'Tu plan anterior ya no está activo');
  assert.equal(marketingFunnelStageLabel('unknown'), 'Etapa no disponible');
});

test('payload de preferencias usa enums nuevos, preserva goal legacy y nunca envía etapa', () => {
  const payload = marketingProfileUpdatePayload('guided_content', [
    'guides_exercises', 'community', 'unexpected', 'community',
  ]);
  assert.deepEqual(payload, {
    goal: 'guided_content',
    content_preferences: ['guides_exercises', 'community'],
  });
  assert.equal(Object.hasOwn(payload, 'funnel_stage'), false);
  assert.deepEqual(marketingProfileUpdatePayload('unexpected', ['offers']), {
    goal: null,
    content_preferences: ['offers'],
  });
});

test('el consentimiento de registro espera verificación de cuenta y DOI', () => {
  const unverified = marketingConsentPresentation({ consent_status: 'awaiting_doi', email_verified: false });
  assert.equal(unverified.visible, false);
  const verified = marketingConsentPresentation({ consent_status: 'pending', email_verified: true });
  assert.equal(verified.visible, true);
  assert.equal(verified.action, 'resend');
});

test('solo la baja confirmada habilita retirar consentimiento y configuración ausente bloquea alta', () => {
  assert.equal(marketingConsentPresentation({ consent_status: 'confirmed' }).action, 'revoke');
  const unavailable = marketingConsentPresentation({ consent_status: 'revoked', consent_configured: false });
  assert.equal(unavailable.disabled, true);
  assert.equal(unavailable.action, 'request');
});

test('un contacto bloqueado nunca recibe un control que pueda solicitar DOI', () => {
  const blocked = marketingConsentPresentation({ consent_status: 'blocked', email_verified: true, consent_configured: true });
  assert.equal(blocked.visible, false);
  assert.equal(blocked.disabled, true);
  assert.equal(blocked.action, 'none');
  assert.match(blocked.description, /contacta a soporte/);
});

test('el parser DOI acepta únicamente un único token URL-safe del fragmento', () => {
  const valid = 'a'.repeat(43);
  assert.equal(readMarketingDoiToken(`#marketing-doi=${valid}`), valid);
  assert.equal(readMarketingDoiToken(`?marketing-doi=${valid}`), null);
  assert.equal(readMarketingDoiToken(`#marketing-doi=${'a'.repeat(31)}`), null);
  assert.equal(readMarketingDoiToken(`#marketing-doi=${valid}&marketing-doi=${valid}`), null);
  assert.equal(readMarketingDoiToken('#marketing-doi=<script>alert(1)</script>'), null);
});

test('limpiar el hash conserva la ruta y query, y los resultados distinguen DOI de sincronización', () => {
  assert.equal(marketingDoiCleanUrl('/confirmar-correo.html', '?campaign=email'), '/confirmar-correo.html?campaign=email');
  assert.match(marketingDoiResultMessage('confirmed').title, /confirmada/);
  assert.match(marketingDoiResultMessage('pending').text, /sincronización/);
});
