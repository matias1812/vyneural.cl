// Six visual OTP slots backed by one real text input. Keeping the actual
// input intact preserves password-manager autofill, paste, keyboard editing,
// and a single accessible focus target.
const DIGITS = /[^0-9]/g;

export function otpCaretForClickedSlot(value, clickedIndex) {
  const length = String(value ?? '').replace(DIGITS, '').slice(0, 6).length;
  const index = Number.isFinite(Number(clickedIndex)) ? Math.max(0, Math.floor(Number(clickedIndex))) : 0;
  // A blank visual slot must not create a hole in the code. Existing slots
  // remain directly editable; every empty slot appends at the first blank.
  return Math.min(index, length);
}

export function otpSlotIndexAtPoint(rects, x, y) {
  if (!Array.isArray(rects) || rects.length === 0) return -1;
  const hit = rects.findIndex((rect) =>
    x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
  if (hit >= 0) return hit;
  let nearest = -1;
  let nearestDistance = Infinity;
  rects.forEach((rect, index) => {
    const centerX = (rect.left + rect.right) / 2;
    const centerY = (rect.top + rect.bottom) / 2;
    const distance = ((x - centerX) ** 2) + ((y - centerY) ** 2);
    if (distance < nearestDistance) {
      nearest = index;
      nearestDistance = distance;
    }
  });
  return nearest;
}

export function enhanceOtpSlots(input, { errorId } = {}) {
  if (!input || input.dataset.otpSlotsEnhanced === 'true') return input;
  const parent = input.parentNode;
  if (!parent) return input;

  const control = document.createElement('div');
  control.className = 'otp-slots-control';
  control.dataset.invalid = 'false';
  parent.insertBefore(control, input);
  control.appendChild(input);

  input.dataset.otpSlotsEnhanced = 'true';
  input.classList.add('otp-slots-input');
  input.type = 'text';
  input.inputMode = 'numeric';
  input.autocomplete = 'one-time-code';
  input.spellcheck = false;
  // Do not let maxlength truncate a mixed paste before we can strip its
  // separators (e.g. "12 34-56"). The sanitized value itself is capped at 6.
  input.removeAttribute('maxlength');
  input.removeAttribute('pattern');
  input.setAttribute('aria-invalid', 'false');
  if (errorId) {
    const ids = new Set((input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
    ids.add(errorId);
    input.setAttribute('aria-describedby', [...ids].join(' '));
  }

  const visual = document.createElement('div');
  visual.className = 'otp-slots';
  visual.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 6; i += 1) {
    const slot = document.createElement('span');
    slot.className = 'otp-slot';
    slot.dataset.index = String(i);
    visual.appendChild(slot);
  }
  control.appendChild(visual);

  const sync = () => {
    const slots = visual.children;
    const value = input.value.replace(DIGITS, '').slice(0, 6);
    const active = document.activeElement === input
      ? Math.min(input.selectionStart ?? value.length, 5)
      : -1;
    for (let i = 0; i < 6; i += 1) {
      slots[i].textContent = value[i] || '';
      slots[i].classList.toggle('is-active', i === active);
    }
    control.classList.toggle('is-focused', document.activeElement === input);
  };

  input.addEventListener('input', () => {
    const raw = input.value;
    const oldStart = input.selectionStart ?? raw.length;
    const clean = raw.replace(DIGITS, '').slice(0, 6);
    if (raw !== clean) {
      const nextStart = Math.min(raw.slice(0, oldStart).replace(DIGITS, '').length, clean.length);
      input.value = clean;
      try { input.setSelectionRange(nextStart, nextStart); } catch (_) { /* unsupported input type */ }
    }
    sync();
  });
  input.addEventListener('focus', sync);
  input.addEventListener('blur', sync);
  input.addEventListener('click', (event) => {
    // Pointer/touch taps should target the visible slot instead of relying on
    // the invisible input's text-layout hit testing. Keyboard-triggered click
    // events have detail=0 and keep the browser's native caret behavior.
    if (event.detail !== 0) {
      const rects = [...visual.children].map((slot) => slot.getBoundingClientRect());
      const index = otpSlotIndexAtPoint(rects, event.clientX, event.clientY);
      if (index >= 0) {
        const caret = otpCaretForClickedSlot(input.value, index);
        try { input.setSelectionRange(caret, caret); } catch (_) { /* unsupported input type */ }
      }
    }
    sync();
  });
  input.addEventListener('keyup', sync);
  sync();
  return input;
}

export function refreshOtpSlots(input) {
  if (!input) return;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

export function setOtpSlotsInvalid(input, invalid) {
  if (!input) return;
  input.setAttribute('aria-invalid', invalid ? 'true' : 'false');
  const control = input.closest('.otp-slots-control');
  if (control) control.dataset.invalid = invalid ? 'true' : 'false';
}
