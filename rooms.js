const crypto = require('crypto');

const rooms = {};

function generateRoomCode() {
  let code;
  do {
    code = Math.random().toString(36).substring(2, 6).toUpperCase();
  } while (rooms[code]);
  return code;
}

function createRoom(hostId) {
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

function rejoinAsHost(code, hostToken, socketId) {
  if (typeof hostToken !== 'string' || !hostToken) return false;
  // Server neu gestartet (Deploy, Render-Neustart): Räume lagen nur im Speicher.
  // Der Host bringt Code und Token mit, also den Raum unter demselben Code neu
  // anlegen; seinen Spielstand schickt er nach der Bestätigung selbst nach.
  if (!rooms[code] && /^[A-Z0-9]{4}$/.test(code)) {
    rooms[code] = { host: socketId, hostToken, hostDisconnectedAt: null, viewers: [], gameState: null };
    return true;
  }
  const room = rooms[code];
  if (!room || room.hostToken !== hostToken) {
    return false;
  }
  room.host = socketId;
  room.hostDisconnectedAt = null;
  // Falls der Host zwischenzeitlich als Viewer gejoint war, dort austragen
  room.viewers = room.viewers.filter(id => id !== socketId);
  return true;
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
