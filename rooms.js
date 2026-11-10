const crypto = require('crypto');

const rooms = {};
const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
// Obergrenze für alle Räume zusammen: jeder hält seinen letzten Spielstand im Speicher
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 500;

const isFull = () => Object.keys(rooms).length >= MAX_ROOMS;

// Immer genau 4 Zeichen (die App prüft das) und nicht vorhersagbar
function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (rooms[code]);
  return code;
}

/** Legt einen Raum an; null, wenn der Server voll ist. */
function createRoom(hostId) {
  if (isFull()) return null;
  const code = generateRoomCode();
  rooms[code] = {
    host: hostId,
    // Geheimnis, mit dem sich der Host nach einem Verbindungsabbruch wieder
    // als Host ausweisen kann (rejoin-room) - Socket-IDs wechseln bei jedem
    // Reconnect, das Token bleibt.
    hostToken: crypto.randomUUID(),
    hostDisconnectedAt: null,
    viewers: [],
    gameState: null
  };
  return { code, hostToken: rooms[code].hostToken };
}

function joinRoom(code, socketId) {
  const room = rooms[code];
  if (!room) {
    return false;
  }
  if (!room.viewers.includes(socketId)) {
    room.viewers.push(socketId);
  }
  return true;
}

/**
 * Host kehrt zurück. Liefert 'rejoined', 'created' (Raum nach einem
 * Server-Neustart neu angelegt) oder false. Mit allowCreate=false wird kein
 * neuer Raum angelegt (der Aufrufer hat die Grenze für neue Räume erreicht).
 */
function rejoinAsHost(code, hostToken, socketId, allowCreate = true) {
  if (typeof hostToken !== 'string' || !hostToken) return false;
  // Server neu gestartet (Deploy, Render-Neustart): Räume lagen nur im Speicher.
  // Der Host bringt Code und Token mit, also den Raum unter demselben Code neu
  // anlegen; seinen Spielstand schickt er nach der Bestätigung selbst nach.
  if (!rooms[code] && /^[A-Z0-9]{4}$/.test(code)) {
    if (!allowCreate || isFull()) return false;
    rooms[code] = { host: socketId, hostToken, hostDisconnectedAt: null, viewers: [], gameState: null };
    return 'created';
  }
  const room = rooms[code];
  if (!room || room.hostToken !== hostToken) {
    return false;
  }
  room.host = socketId;
  room.hostDisconnectedAt = null;
  // Falls der Host zwischenzeitlich als Viewer gejoint war, dort austragen
  room.viewers = room.viewers.filter(id => id !== socketId);
  return 'rejoined';
}

function markHostDisconnected(code) {
  if (rooms[code]) {
    rooms[code].hostDisconnectedAt = Date.now();
  }
}

/** Räume, deren Host länger als ttlMs weg ist - Aufräumen übernimmt der Aufrufer. */
function sweepExpiredRooms(ttlMs) {
  const now = Date.now();
  return Object.entries(rooms)
    .filter(([_, room]) => room.hostDisconnectedAt !== null && now - room.hostDisconnectedAt > ttlMs)
    .map(([code]) => code);
}

function updateRoomState(code, state) {
  if (rooms[code]) {
    rooms[code].gameState = state;
  }
}

function getRoom(code) {
  return rooms[code];
}

function getRoomCodeBySocketId(socketId) {
  return Object.entries(rooms).find(
    ([_, room]) => room.host === socketId || room.viewers.includes(socketId)
  )?.[0];
}

function removeViewer(code, socketId) {
  if (rooms[code]) {
    rooms[code].viewers = rooms[code].viewers.filter(id => id !== socketId);
  }
}

function deleteRoom(code) {
  delete rooms[code];
}

module.exports = {
  MAX_ROOMS,
  createRoom,
  joinRoom,
  rejoinAsHost,
  markHostDisconnected,
  sweepExpiredRooms,
  updateRoomState,
  getRoom,
  getRoomCodeBySocketId,
  removeViewer,
  deleteRoom
};
