// src/restablecer.js
// Página /restablecer — establece una contraseña nueva con el token de un
// solo uso que llegó por email (?token=…). Exige confirmar la contraseña.

import { resetPassword } from './api/auth.js';
import { validatePasswordStrength } from './ui/auth.js';

const $ = (id) => document.getElementById(id);

function setError(msg) {
  const err = $('reset-error');
  if (!err) return;
  err.textContent = msg || '';
  err.classList.toggle('hidden', !msg);
}

function setNote(msg) {
  const note = $('reset-note');
  if (!note) return;
  note.textContent = msg || '';
  note.hidden = !msg;
}

function showDone() {
  $('reset-form').hidden = true;
  const done = $('reset-done');
  if (done) done.hidden = false;
}

async function run() {
  const params = new URLSearchParams(window.location.search);
  const token = (params.get('token') || '').trim();
  const form = $('reset-form');

  if (!token) {
    setNote('Falta el código de recuperación. Usá el enlace completo que te enviamos por correo.');
    if (form) form.hidden = true;
    return;
  }

  const loginBtn = $('reset-to-login');
  if (loginBtn) {
    loginBtn.addEventListener('click', () => {
      window.location.href = '/';
    });
  }

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = $('reset-password').value;
      const confirm = $('reset-confirm').value;

      const pwError = validatePasswordStrength(password);
      if (pwError) {
        setError(pwError);
        return;
      }
      if (password !== confirm) {
        setError('Las contraseñas no coinciden.');
        return;
      }

      const submit = $('reset-submit');
      submit.disabled = true;
      setError(null);
      try {
        await resetPassword(token, password);
        showDone();
      } catch (err) {
        const status = err && err.status;
        const detail = (err && err.detail) || '';
        if (status === 400 && /venció/i.test(detail)) {
          setError('El enlace venció (dura 30 minutos). Pedí uno nuevo desde "Olvidé mi contraseña".');
        } else if (status === 400) {
          setError('El enlace no es válido o ya fue usado. Pedí uno nuevo.');
        } else if (detail && typeof detail === 'string') {
          setError(detail.slice(0, 200));
        } else {
          setError('No se pudo restablecer la contraseña. Intentá de nuevo.');
        }
      } finally {
        submit.disabled = false;
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', run, { once: true });
