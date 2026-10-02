// scripts/bridge-login-probe.mjs — POST /auth/login directo por el bridge
// nativo (API_REQUEST) para depurar la cadena sin la UI.
// Uso: EMAIL=… PASS=… node scripts/bridge-login-probe.mjs
//
// OJO con cuentas que tengan verificación en dos pasos activa: ahí
// POST /auth/login responde 200 con { requires_totp, challenge_token } y SIN
// access_token (es correcto, falta el segundo factor — ver
// backend/app/routers/auth.py::login). O sea, `hasAccessToken: false` NO
// significa que la cadena del bridge esté rota: probá con una cuenta sin 2FA
// para depurar el transporte.
import http from 'http';

const email = process.env.EMAIL;
const pass = process.env.PASS;
if (!email || !pass) throw new Error('EMAIL/PASS requeridos');

const list = await new Promise((resolve, reject) =>
  http.get('http://127.0.0.1:9222/json/list', (r) => {
    let d = '';
    r.on('data', (c) => (d += c));
    r.on('end', () => resolve(JSON.parse(d)));
  }).on('error', reject),
);
const page = list.find((x) => x.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  }
};
await new Promise((res) => (ws.onopen = res));
const cmd = (method, params = {}) =>
  new Promise((res) => {
    const myId = ++id;
    pending.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
await cmd('Runtime.enable');

const expression = `(async () => {
  window.__vyneuralApiResponse = (rid, json) => { window.__lastResp = json; };
  const body = JSON.stringify({ email: ${JSON.stringify(email)}, password: ${JSON.stringify(pass)} });
  const ack = AndroidBridgeNative.postMessage(JSON.stringify({
    command: 'API_REQUEST',
    payload: { id: 777, method: 'POST', path: '/api/v1/auth/login', headers: { 'Content-Type': 'application/json' }, body }
  }));
  await new Promise((r) => setTimeout(r, 6000));
  const resp = window.__lastResp || null;
  let parsed = null;
  try { parsed = resp ? JSON.parse(resp) : null; } catch (_) { parsed = null; }
  return JSON.stringify({
    ack,
    resp: resp ? resp.slice(0, 300) : null,
    parsedStatus: parsed ? parsed.status : null,
    hasAccessToken: parsed && parsed.body ? parsed.body.includes('access_token') : false,
  });
})()`;

const ev = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
console.log(ev.result.value);
ws.close();
