const http = require('http');
const { Server } = require('socket.io');
const {
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
} = require('./rooms');
const { handleFeedback } = require('./feedback');

// Räume, deren Host so lange getrennt ist, werden aufgeräumt (Env überschreibbar,
// v.a. für Tests). 15 Minuten decken App-Wechsel/kurze Funklöcher großzügig ab.
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS) || 15 * 60 * 1000;
const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS) || 60 * 1000;

// Kein Express nötig - es gibt nur den Health-Check und /feedback, und
// socket.io regelt CORS selbst. /healthz dient auch als Ziel für einen
// Keep-Alive-Pinger gegen Render-Cold-Starts.
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (req.url === '/feedback') {
    handleFeedback(req, res);
    return;
  }
  res.writeHead(404);
  res.end();
});

const io = new Server(server, {
  cors: { origin: '*' }
});

// Ein einzelnes kaputtes Emit darf niemals den Prozess (und damit alle Räume)
// umreißen - deshalb ist jeder Handler defensiv gekapselt.
function safeHandler(name, handler) {
  return (...args) => {
    try {
      handler(...args);
    } catch (err) {
      console.error(`💥 Fehler im Handler "${name}":`, err.message);
    }
  };
}

io.on('connection', (socket) => {
  console.log(`🔌 New connection: ${socket.id}`);

  socket.on('create-room', safeHandler('create-room', (_, callback) => {
    if (typeof callback !== 'function') return;
    const { code, hostToken } = createRoom(socket.id);
    socket.join(code);
    console.log(`🎮 Room created: ${code}`);
    callback({ roomCode: code, hostToken });
  }));

  socket.on('join-room', safeHandler('join-room', (roomCode, callback) => {
    if (typeof callback !== 'function') return;
    if (typeof roomCode !== 'string' || !joinRoom(roomCode, socket.id)) {
      callback({ success: false, message: 'Room not found' });
      return;
    }
    socket.join(roomCode);
    console.log(`👀 ${socket.id} joined ${roomCode}`);
    callback({ success: true });
    // State-Replay: neuer/wiederkehrender Viewer sieht sofort den aktuellen
    // Spielstand statt bis zur nächsten Host-Aktion auf einen leeren Screen.
    const room = getRoom(roomCode);
    if (room?.gameState) {
      socket.emit('game-state', room.gameState);
    }
  }));

  // Host-Reconnect: Socket-IDs wechseln bei jedem Verbindungsaufbau, deshalb
  // weist sich der Host mit dem bei create-room ausgegebenen Token aus.
  socket.on('rejoin-room', safeHandler('rejoin-room', (payload, callback) => {
    if (typeof callback !== 'function') return;
    const { roomCode, hostToken } = payload ?? {};
    if (typeof roomCode !== 'string' || !rejoinAsHost(roomCode, hostToken, socket.id)) {
      callback({ success: false, message: 'Room not found or invalid token' });
      return;
    }
    socket.join(roomCode);
    console.log(`🔁 Host ${socket.id} rejoined ${roomCode}`);
    callback({ success: true });
    const room = getRoom(roomCode);
    if (room?.gameState) {
      socket.emit('game-state', room.gameState);
    }
  }));

  socket.on('game-update', safeHandler('game-update', (payload) => {
    const { roomCode, gameState } = payload ?? {};
    if (typeof roomCode !== 'string' || !gameState) return;
    // Nur der Host darf State pushen - sonst könnte jeder mit Raumcode
    // beliebigen Spielstand an alle broadcasten.
    if (getRoom(roomCode)?.host !== socket.id) return;
    updateRoomState(roomCode, gameState);
    socket.to(roomCode).emit('game-state', gameState);
  }));

  socket.on('leave-room', safeHandler('leave-room', (roomCode) => {
    if (typeof roomCode !== 'string') return;
    const room = getRoom(roomCode);
    if (!room) return;

    if (room.host === socket.id) {
      // Nur hier wird der Raum aktiv geschlossen
      io.to(roomCode).emit('room-closed');
      io.in(roomCode).socketsLeave(roomCode);
      deleteRoom(roomCode);
      console.log(`🔒 Raum ${roomCode} wurde bewusst geschlossen (Host hat verlassen)`);
    } else {
      removeViewer(roomCode, socket.id);
      socket.leave(roomCode);
      console.log(`👤 Zuschauer hat Raum ${roomCode} verlassen`);
    }
  }));

  socket.on('disconnect', safeHandler('disconnect', () => {
    console.log(`❌ ${socket.id} disconnected`);

    const roomCode = getRoomCodeBySocketId(socket.id);
    if (!roomCode) return;

    const room = getRoom(roomCode);

    if (room?.host === socket.id) {
      // Host-Verbindung verloren - Raum bleibt bestehen, damit der Host per
      // rejoin-room zurückkommen kann. Der Sweep unten räumt verwaiste Räume ab.
      markHostDisconnected(roomCode);
      console.log(`⚠️ Host ${socket.id} aus Raum ${roomCode} hat Verbindung verloren`);
    } else {
      removeViewer(roomCode, socket.id);
      console.log(`👤 Zuschauer aus Raum ${roomCode} getrennt`);
    }
  }));
});

// Verwaiste Räume (Host weg, nie zurückgekommen) aufräumen, sonst wächst die
// rooms-Map bis zum nächsten Prozess-Neustart unbegrenzt.
setInterval(() => {
  for (const code of sweepExpiredRooms(ROOM_TTL_MS)) {
    io.to(code).emit('room-closed');
    io.in(code).socketsLeave(code);
    deleteRoom(code);
    console.log(`🧹 Raum ${code} aufgeräumt (Host seit >${ROOM_TTL_MS / 1000}s getrennt)`);
  }
}, SWEEP_INTERVAL_MS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
