// rooms.js

const rooms = {};

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function createRoom(hostId) {
  const code = generateRoomCode();
  rooms[code] = {
    host: hostId,
    viewers: [],
    gameState: null
  };
  return code;
}

function joinRoom(code, socketId) {
  if (rooms[code]) {
    rooms[code].viewers.push(socketId);
    return true;
  }
  return false;
}

function updateRoomState(code, state) {
  if (rooms[code]) {
    rooms[code].gameState = state;
  }
}

function getRoomViewers(code) {
  return rooms[code]?.viewers || [];
}

module.exports = {
  createRoom,
  joinRoom,
  updateRoomState,
  getRoomViewers
};