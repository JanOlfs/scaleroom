const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const {
  createRoom,
  joinRoom,
  updateRoomState,
  getRoom,
  getRoomCodeBySocketId,
  removeViewer,
  deleteRoom
} = require('./rooms');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(cors());

io.on('connection', (socket) => {
  console.log(`🔌 New connection: ${socket.id}`);

  socket.on('create-room', (_, callback) => {
    const roomCode = createRoom(socket.id);
    socket.join(roomCode);
    console.log(`🎮 Room created: ${roomCode}`);
    callback(roomCode);
  });

  socket.on('join-room', (roomCode, callback) => {
    const success = joinRoom(roomCode, socket.id);
    if (success) {
      socket.join(roomCode);
      console.log(`👀 ${socket.id} joined ${roomCode}`);
      callback({ success: true });
    } else {
      callback({ success: false, message: 'Room not found' });
    }
  });

  socket.on('game-update', ({ roomCode, gameState }) => {
    updateRoomState(roomCode, gameState);
    socket.to(roomCode).emit('game-state', gameState);
  });

  socket.on('leave-room', (roomCode) => {
    const room = getRoom(roomCode);
    if (!room) return;

    if (room.host === socket.id) {
      // Host verlässt → Raum schließen
      io.to(roomCode).emit('room-closed');
      io.in(roomCode).socketsLeave(roomCode);
      deleteRoom(roomCode);
      console.log(`🔒 Raum ${roomCode} wurde geschlossen (Host ist gegangen)`);
    } else {
      removeViewer(roomCode, socket.id);
      socket.leave(roomCode);
      console.log(`👤 Zuschauer hat Raum ${roomCode} verlassen`);
    }
  });

  socket.on('disconnect', () => {
    console.log(`❌ ${socket.id} disconnected`);

    const roomCode = getRoomCodeBySocketId(socket.id);
    if (!roomCode) return;

    const room = getRoom(roomCode);

    if (room?.host === socket.id) {
      io.to(roomCode).emit('room-closed');
      io.in(roomCode).socketsLeave(roomCode);
      deleteRoom(roomCode);
      console.log(`⚠️ Host hat die Verbindung verloren – Raum ${roomCode} geschlossen`);
    } else {
      removeViewer(roomCode, socket.id);
      socket.leave(roomCode);
      console.log(`👤 Zuschauer aus Raum ${roomCode} getrennt`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});