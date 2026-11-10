// node --test: schnelle Prüfung der Teile ohne Netzwerk
const test = require('node:test');
const assert = require('node:assert');
const { rateLimited, clientIp } = require('./feedback');
const { createRoom, rejoinAsHost, getRoom } = require('./rooms');

test('echte IP ist der letzte X-Forwarded-For-Eintrag (den setzt der Proxy)', () => {
  assert.strictEqual(clientIp({ headers: { 'x-forwarded-for': '1.1.1.1, 9.9.9.9' }, socket: {} }), '9.9.9.9');
  assert.strictEqual(clientIp({ headers: {}, socket: { remoteAddress: '5.5.5.5' } }), '5.5.5.5');
});

test('Rate-Limit: 10 pro IP und Stunde, danach wieder frei', () => {
  const t = 1e12;
  for (let i = 0; i < 10; i++) assert.strictEqual(rateLimited('a', t), false);
  assert.strictEqual(rateLimited('a', t), true);
  assert.strictEqual(rateLimited('b', t), false);
  assert.strictEqual(rateLimited('a', t + 61 * 60 * 1000), false);
});

test('Rate-Limit: Obergrenze über alle IPs', () => {
  const t = 2e12;
  let blocked = 0;
  for (let i = 0; i < 100; i++) if (rateLimited(`ip${i}`, t)) blocked++;
  assert.strictEqual(blocked, 40); // 60 erlaubt
});

test('Host-Rejoin legt nach einem Server-Neustart den Raum unter demselben Code neu an', () => {
  assert.strictEqual(rejoinAsHost('AB12', 'token-x', 's1'), true);
  assert.strictEqual(getRoom('AB12').host, 's1');
  assert.strictEqual(rejoinAsHost('AB12', 'falsch', 's2'), false);
  assert.strictEqual(rejoinAsHost('AB12', 'token-x', 's3'), true);
  assert.strictEqual(rejoinAsHost('zu-lang', 'token', 's4'), false);
  const { code, hostToken } = createRoom('h');
  assert.strictEqual(rejoinAsHost(code, 'fremd', 'x'), false);
  assert.strictEqual(rejoinAsHost(code, hostToken, 'h2'), true);
});
