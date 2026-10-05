import test from 'node:test';
import assert from 'node:assert/strict';
import { otpCaretForClickedSlot, otpSlotIndexAtPoint } from '../src/ui/otp-slots.js';

const slotRects = [0, 1, 2, 3, 4, 5].map((index) => ({
  left: index * 48,
  right: index * 48 + 40,
  top: 10,
  bottom: 60,
}));

test('clicking an occupied OTP slot places the caret at that digit', () => {
  assert.equal(otpCaretForClickedSlot('012345', 0), 0);
  assert.equal(otpCaretForClickedSlot('012345', 3), 3);
  assert.equal(otpCaretForClickedSlot('012345', 5), 5);
});

test('clicking any empty slot appends at the first blank without making a gap', () => {
  assert.equal(otpCaretForClickedSlot('', 4), 0);
  assert.equal(otpCaretForClickedSlot('012', 3), 3);
  assert.equal(otpCaretForClickedSlot('012', 5), 3);
});

test('click location resolves the actual slot and gaps to the nearest slot', () => {
  assert.equal(otpSlotIndexAtPoint(slotRects, 110, 30), 2);
  assert.equal(otpSlotIndexAtPoint(slotRects, 44, 30), 0);
  assert.equal(otpSlotIndexAtPoint(slotRects, 285, 30), 5);
  assert.equal(otpSlotIndexAtPoint([], 10, 10), -1);
});
