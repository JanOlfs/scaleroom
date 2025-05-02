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
  updateRoomState,
  getRoom,
  getRoomCodeBySocketId,
  removeViewer,
  deleteRoom
};