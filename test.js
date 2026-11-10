// node --test: schnelle Prüfung der Teile ohne Netzwerk (der Server als Ganzes: server.test.js)
process.env.MAX_ROOMS = '30';

const test = require('node:test');
const assert = require('node:assert');
const { rateLimited, clientIp, parseFeedback, issueBody } = require('./feedback');
const { createLimiter } = require('./limits');
const {
  createRoom, joinRoom, rejoinAsHost, getRoom, deleteRoom, removeViewer,
  markHostDisconnected, sweepExpiredRooms, getRoomCodeBySocketId, updateRoomState,
} = require('./rooms');

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

test('Zähler mit Zeitfenster: sperrt je Schlüssel und gibt nach Ablauf wieder frei', () => {
  const limiter = createLimiter(3, 1000);
  const t = 5e12;
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(limiter.blocked('a', t), false);
    limiter.count('a', t + i);
  }
  assert.strictEqual(limiter.blocked('a', t + 10), true);
  assert.strictEqual(limiter.blocked('b', t + 10), false); // andere IP unberührt
  assert.strictEqual(limiter.blocked('a', t + 999), true); // alle drei noch im Fenster
  assert.strictEqual(limiter.blocked('a', t + 1001), false); // der erste ist abgelaufen
  limiter.count('b', t + 10);

  assert.strictEqual(limiter.size, 2);
  limiter.sweep(t + 5000);
  assert.strictEqual(limiter.size, 0); // Abgelaufenes belegt keinen Speicher
});

test('Raumcodes haben immer genau 4 Buchstaben oder Ziffern und sind eindeutig', () => {
  const codes = new Set();
  for (let i = 0; i < 20; i++) {
    const { code, hostToken } = createRoom(`host${i}`);
    assert.match(code, /^[A-Z0-9]{4}$/);
    assert.ok(hostToken.length > 20);
    codes.add(code);
  }
  assert.strictEqual(codes.size, 20);
  codes.forEach(deleteRoom);
});

test('Zuschauer: beitreten nur in bestehende Räume, doppelt zählt einfach', () => {
  const { code } = createRoom('h');
  assert.strictEqual(joinRoom('NOPE', 'v1'), false);
  assert.strictEqual(joinRoom(code, 'v1'), true);
  assert.strictEqual(joinRoom(code, 'v1'), true);
  assert.deepStrictEqual(getRoom(code).viewers, ['v1']);
  assert.strictEqual(getRoomCodeBySocketId('v1'), code);
  assert.strictEqual(getRoomCodeBySocketId('h'), code);
  removeViewer(code, 'v1');
  assert.strictEqual(getRoomCodeBySocketId('v1'), undefined);
  deleteRoom(code);
});

test('Host-Rejoin: nur mit dem richtigen Token, Spielstand bleibt', () => {
  const { code, hostToken } = createRoom('h');
  updateRoomState(code, { gameMessage: 'stand' });
  joinRoom(code, 'h2'); // kam zwischendurch als Zuschauer zurück
  assert.strictEqual(rejoinAsHost(code, 'fremd', 'x'), false);
  assert.strictEqual(rejoinAsHost(code, undefined, 'x'), false);
  assert.strictEqual(rejoinAsHost(code, hostToken, 'h2'), 'rejoined');
  assert.strictEqual(getRoom(code).host, 'h2');
  assert.deepStrictEqual(getRoom(code).viewers, []);
  assert.deepStrictEqual(getRoom(code).gameState, { gameMessage: 'stand' });
  deleteRoom(code);
});

test('Host-Rejoin legt nach einem Server-Neustart den Raum unter demselben Code neu an', () => {
  assert.strictEqual(rejoinAsHost('AB12', 'token-x', 's1'), 'created');
  assert.strictEqual(getRoom('AB12').host, 's1');
  assert.strictEqual(rejoinAsHost('AB12', 'falsch', 's2'), false);
  assert.strictEqual(rejoinAsHost('AB12', 'token-x', 's3'), 'rejoined');
  assert.strictEqual(rejoinAsHost('zu-lang', 'token', 's4'), false);
  // wer die Grenze für neue Räume erreicht hat, legt auch so keinen an
  assert.strictEqual(rejoinAsHost('CD34', 'token', 's5', false), false);
  assert.strictEqual(getRoom('CD34'), undefined);
  deleteRoom('AB12');
});

test('verwaiste Räume: nur wessen Host lange genug weg ist', () => {
  const kept = createRoom('da').code;
  const gone = createRoom('weg').code;
  markHostDisconnected(gone);
  getRoom(gone).hostDisconnectedAt -= 20 * 60 * 1000;
  const brief = createRoom('kurz').code;
  markHostDisconnected(brief);
  assert.deepStrictEqual(sweepExpiredRooms(15 * 60 * 1000), [gone]);
  [kept, gone, brief].forEach(deleteRoom);
});

test('Obergrenze für alle Räume zusammen', () => {
  const codes = [];
  for (let i = 0; i < 30; i++) codes.push(createRoom(`h${i}`).code);
  assert.strictEqual(createRoom('einer-zu-viel'), null);
  assert.strictEqual(rejoinAsHost('ZZ99', 'token', 'x'), false);
  deleteRoom(codes[0]);
  assert.ok(createRoom('wieder-platz'));
});

test('Feedback: prüft Art, Text und Bilder und schneidet zu', () => {
  const png = `data:image/png;base64,${Buffer.from('bild').toString('base64')}`;
  const ok = parseFeedback(JSON.stringify({
    kind: 'bug', text: '  Waage hängt  ', name: 'x'.repeat(100), images: [png],
    meta: { App: '1.2.0', Gerät: 'y'.repeat(500) }, diagnostics: '{"a":1}',
  }));
  assert.strictEqual(ok.text, 'Waage hängt');
  assert.strictEqual(ok.name.length, 60);
  assert.strictEqual(ok.images[0].ext, 'png');
  assert.strictEqual(ok.images[0].buffer.toString(), 'bild');
  assert.strictEqual(ok.meta['Gerät'].length, 300);
  assert.strictEqual(ok.diagnostics, '{"a":1}');

  const status = (raw) => {
    try {
      parseFeedback(raw);
    } catch (err) {
      return err.status;
    }
    return 200;
  };
  assert.strictEqual(status('kein json'), 400);
  assert.strictEqual(status(JSON.stringify({ kind: 'spam', text: 'x' })), 400);
  assert.strictEqual(status(JSON.stringify({ kind: 'bug', text: '   ' })), 400);
  assert.strictEqual(status(JSON.stringify({ kind: 'bug', text: 'x', images: ['data:text/html;base64,AAAA'] })), 400);
  const big = `data:image/png;base64,${Buffer.alloc(3 * 1024 * 1024 + 1).toString('base64')}`;
  assert.strictEqual(status(JSON.stringify({ kind: 'bug', text: 'x', images: [big] })), 413);
  // mehr als 5 Bilder: die überzähligen fallen weg
  assert.strictEqual(parseFeedback(JSON.stringify({ kind: 'feature', text: 'x', images: Array(8).fill(png) })).images.length, 5);
});

test('Feedback: der Issue-Text benachrichtigt niemanden und zerlegt die Tabelle nicht', () => {
  const body = issueBody(
    { kind: 'bug', text: 'Hallo @JanOlfs\nzweite Zeile', name: '@admin', meta: { Gerät: 'a|b' } },
    { images: ['https://example.test/bild-1.png'], diagnostics: 'https://example.test/diagnose.json' }
  );
  assert.ok(!/@[A-Za-z]/.test(body)); // jedes @ ist entschärft
  assert.ok(body.includes('> zweite Zeile'));
  assert.ok(body.includes('![Bild](https://example.test/bild-1.png)'));
  assert.ok(body.includes('[diagnose.json](https://example.test/diagnose.json)'));
  assert.ok(body.includes('| Gerät | a/b |'));
});
