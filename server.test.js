// node --test: der ganze Server über echte socket.io-Verbindungen auf einem freien Port.
// Die Grenzen sind hier klein gestellt, jeder Test nutzt eine eigene (vorgetäuschte) IP.
process.env.JOIN_FAIL_LIMIT = '5';
process.env.CREATE_LIMIT = '4';
delete process.env.GITHUB_TOKEN;

const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { server, io } = require('./server');

let url;
const sockets = [];

test.before(() => new Promise((resolve) => server.listen(0, () => {
  url = `http://localhost:${server.address().port}`;
  resolve();
})));

test.after(() => {
  sockets.forEach((s) => s.close());
  io.close();
});

/** Neue Verbindung, als käme sie von dieser IP (der Proxy setzt X-Forwarded-For). */
const open = (ip) => new Promise((resolve, reject) => {
  const socket = connect(url, { transports: ['websocket'], forceNew: true, extraHeaders: { 'x-forwarded-for': ip } });
  sockets.push(socket);
  socket.on('connect', () => resolve(socket));
  socket.on('connect_error', reject);
});
const ask = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));
const next = (socket, event) => new Promise((resolve) => socket.once(event, resolve));
/** Kommt in der kurzen Zeit nichts an, gilt das Ereignis als ausgeblieben. */
const silent = (socket, event) => Promise.race([
  next(socket, event).then(() => false),
  new Promise((resolve) => setTimeout(() => resolve(true), 150)),
]);

test('Host legt einen Raum an, Zuschauer bekommen den Spielstand', async () => {
  const host = await open('10.0.0.1');
  const viewer = await open('10.0.0.1');
  const { roomCode, hostToken } = await ask(host, 'create-room', null);
  assert.match(roomCode, /^[A-Z0-9]{4}$/);
  assert.ok(hostToken);

  assert.deepStrictEqual(await ask(viewer, 'join-room', roomCode), { success: true });
  const update = next(viewer, 'game-state');
  host.emit('game-update', { roomCode, gameState: { gameMessage: 'hallo' } });
  assert.deepStrictEqual(await update, { gameMessage: 'hallo' });

  // wer später dazukommt, sieht sofort den letzten Stand
  const late = await open('10.0.0.1');
  const replay = next(late, 'game-state');
  await ask(late, 'join-room', roomCode);
  assert.deepStrictEqual(await replay, { gameMessage: 'hallo' });
});

test('nur der Host darf den Spielstand ändern', async () => {
  const host = await open('10.0.0.2');
  const viewer = await open('10.0.0.2');
  const cheater = await open('10.0.0.2');
  const { roomCode } = await ask(host, 'create-room', null);
  await ask(viewer, 'join-room', roomCode);
  await ask(cheater, 'join-room', roomCode);

  const nothing = silent(viewer, 'game-state');
  cheater.emit('game-update', { roomCode, gameState: { gameMessage: 'gefälscht' } });
  assert.strictEqual(await nothing, true);
});

test('verlässt der Host den Raum, ist er für alle zu', async () => {
  const host = await open('10.0.0.3');
  const viewer = await open('10.0.0.3');
  const { roomCode } = await ask(host, 'create-room', null);
  await ask(viewer, 'join-room', roomCode);

  const closed = next(viewer, 'room-closed');
  host.emit('leave-room', roomCode);
  await closed;
  assert.strictEqual((await ask(viewer, 'join-room', roomCode)).success, false);
});

test('ein Zuschauer, der geht, schließt den Raum nicht', async () => {
  const host = await open('10.0.0.4');
  const viewer = await open('10.0.0.4');
  const { roomCode } = await ask(host, 'create-room', null);
  await ask(viewer, 'join-room', roomCode);
  viewer.emit('leave-room', roomCode);
  const other = await open('10.0.0.4');
  assert.strictEqual((await ask(other, 'join-room', roomCode)).success, true);
});

test('der Host kommt nach einem Abbruch nur mit seinem Token zurück', async () => {
  const host = await open('10.0.0.5');
  const { roomCode, hostToken } = await ask(host, 'create-room', null);
  const witness = await open('10.0.0.5');
  await ask(witness, 'join-room', roomCode);
  const arrived = next(witness, 'game-state');
  host.emit('game-update', { roomCode, gameState: { gameMessage: 'vor dem Abbruch' } });
  await arrived; // erst trennen, wenn der Stand beim Server ist
  host.close();

  const stranger = await open('10.0.0.5');
  assert.strictEqual((await ask(stranger, 'rejoin-room', { roomCode, hostToken: 'geraten' })).success, false);

  const back = await open('10.0.0.5');
  const replay = next(back, 'game-state');
  assert.strictEqual((await ask(back, 'rejoin-room', { roomCode, hostToken })).success, true);
  assert.deepStrictEqual(await replay, { gameMessage: 'vor dem Abbruch' });

  // und darf wieder senden
  const viewer = await open('10.0.0.5');
  await ask(viewer, 'join-room', roomCode);
  const update = next(viewer, 'game-state');
  back.emit('game-update', { roomCode, gameState: { gameMessage: 'wieder da' } });
  assert.deepStrictEqual(await update, { gameMessage: 'wieder da' });
});

test('wer Raumcodes durchprobiert, wird gesperrt; andere IPs nicht', async () => {
  const host = await open('10.0.0.6');
  const { roomCode } = await ask(host, 'create-room', null);

  const guesser = await open('6.6.6.6');
  for (let i = 0; i < 5; i++) {
    assert.strictEqual((await ask(guesser, 'join-room', `XX${i}0`)).success, false);
  }
  // jetzt hilft auch der richtige Code nicht mehr, auch nicht über eine neue Verbindung
  assert.strictEqual((await ask(guesser, 'join-room', roomCode)).success, false);
  const again = await open('6.6.6.6');
  assert.strictEqual((await ask(again, 'join-room', roomCode)).success, false);

  const guest = await open('10.0.0.7');
  assert.strictEqual((await ask(guest, 'join-room', roomCode)).success, true);
});

test('eine IP kann nicht beliebig viele Räume anlegen', async () => {
  const host = await open('7.7.7.7');
  for (let i = 0; i < 4; i++) {
    assert.ok((await ask(host, 'create-room', null)).roomCode);
  }
  assert.strictEqual((await ask(host, 'create-room', null)).roomCode, undefined);
  // auch nicht über den Umweg "Raum nach Server-Neustart neu anlegen"
  assert.strictEqual((await ask(host, 'rejoin-room', { roomCode: 'ZZ99', hostToken: 'token' })).success, false);
});

test('kaputte Nachrichten bringen den Server nicht aus dem Tritt', async () => {
  const socket = await open('10.0.0.8');
  socket.emit('game-update', null);
  socket.emit('game-update', { roomCode: 42 });
  socket.emit('leave-room', { kein: 'Text' });
  socket.emit('join-room', 'ABCD'); // ohne Rückruf
  assert.strictEqual((await ask(socket, 'join-room', null)).success, false);
  assert.strictEqual((await ask(socket, 'rejoin-room', null)).success, false);
  assert.ok((await ask(socket, 'create-room', null)).roomCode);
});

test('HTTP: Lebenszeichen, unbekannte Pfade, Feedback ohne Einrichtung', async () => {
  const health = await fetch(`${url}/healthz`);
  assert.strictEqual(health.status, 200);
  assert.strictEqual(await health.text(), 'ok');
  assert.strictEqual((await fetch(`${url}/gibtsnicht`)).status, 404);

  const feedback = await fetch(`${url}/feedback`, { method: 'POST', body: JSON.stringify({ kind: 'bug', text: 'x' }) });
  assert.strictEqual(feedback.status, 503); // kein GITHUB_TOKEN gesetzt
  const preflight = await fetch(`${url}/feedback`, { method: 'OPTIONS' });
  assert.strictEqual(preflight.status, 204);
  assert.strictEqual(preflight.headers.get('access-control-allow-origin'), '*');
});
