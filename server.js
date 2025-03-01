const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const morgan = require('morgan');
require('dotenv').config();
require('./src/utils/initDb');
const cors = require('cors');
const webpush = require('web-push');
const authRoutes = require('./src/routes/auth');
const errorHandler = require('./src/middleware/errorHandler');
const { pool } = require('./src/utils/db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

webpush.setVapidDetails(
  'mailto:tuo@email.com',
  'BORD1xKlW2VpTt09le-kUumh_paB7Tf9eOqh4vjHDtE70IMV19mVWeA35gvI_uw9_NdmHLYb4DL5UCcYIsPQRDI',
  'u39L4Ib9MM9sfw9pfBnTPYhdIxdHzq13P_LYI1hWYBA'
);

app.use(cors());
app.use(morgan('combined'));
app.use(express.json());
app.use('/auth', authRoutes);
app.use(errorHandler);

let users = [];
let rooms = [];

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('userLoggedIn', (userId) => {
    users.push({userId: userId.userId, socketId: socket.id});
    console.log(`User ${userId.userId} associated with socket ${socket.id}`);
  });

  socket.on('createRoom', ({ userId, userName }) => {
    const roomId = `room_${Date.now()}`;
    const newRoom = { id: roomId, players: [{ playerId: userId, playerName: userName, isCreator: true }], status: 'waiting' };
    rooms.push(newRoom);
    io.to(socket.id).emit('roomCreated', newRoom);
  });

  socket.on('joinRoom', ({ userId, userName, roomId }) => {
    const room = rooms.find(r => r.id === roomId);
    console.log('users', users)
    console.log('userId', userId)

    if (room && room.players.length < 5) {
      console.log(room, userId)
      room.players.push({ playerId: userId, playerName: userName, isCreator: false });
      room.players.forEach(player => io.to(users.find(u => u.userId === player.playerId)?.socketId).emit('roomUpdated', room));
    } else {
      io.to(socket.id).emit('roomFull', `Stanza ${roomId} piena o inesistente.`);
    }
  });

  socket.on('sendMessage', ({ userId, roomId, message }) => {
    const room = rooms.find(r => r.id === roomId);
    if (room) {
      room.players.forEach(player => io.to(users.find(u => u.userId === player.playerId)?.socketId).emit('newMessage', { userId, message }));
    }
  });

  socket.on('notification', async (friendId) => {
    if (io.to(users.find(u => u.userId === friendId))) {
      io.to(users.find(u => u.userId === friendId)?.socketId).emit('notification', { message: 'Nuovo messaggio ricevuto' });
    } else {
      try {
        const result = await pool.query('SELECT * FROM subscriptions WHERE user_id = $1', [friendId]);
        if (result.rowCount > 0) {
          const sub = result.rows[0];
          const subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh_key, auth: sub.auth_key } };
          sendPushNotification(subscription, 'Nuovo Messaggio', 'Hai una nuova notifica!');
        }
      } catch (err) {
        console.error('Error sending push notification:', err);
      }
    }
  });

  socket.on('exit', () => {
    const userId = users.find(u => u.socketId === socket.id)?.socketId;;
    rooms.forEach(room => {
      room.players = room.players.filter(player => player.playerId !== userId);
      if (room.players.length === 0) rooms = rooms.filter(r => r.id !== room.id);
      else room.players.forEach(p => io.to(users.find(u => u.userId === p.playerId)?.socketId).emit('roomUpdated', room));
    });
  });

  socket.on('getRooms', () => {
    // Respond with the list of rooms
    socket.emit('roomsData', rooms);  // Send rooms data back to the client
  });

  socket.on('findOpponent', (userId) => {
    console.log(`Finding opponent for ${userId}`);
    // Logica per trovare un avversario
    io.emit('opponentFound', { userId, opponent: 'opponent data' });
  });

  // Aggiorna la stanza
  socket.on('updateRoom', (settings) => {
    const { roomId, newSettings } = settings;
    
    // Find the room by roomId
    const room = rooms.find(r => r.id === roomId);
    
    if (room) {
      Object.assign(room, newSettings);
      
      room.players.forEach(p => {
        const socket = users.find(u => u.userId === p.playerId)?.socketId
        if (socket) {
          io.to(socket).emit('roomUpdated', room);
        }
      });
    } else {
      console.log(`Room with ID ${roomId} not found.`);
    }
  });
  
  
  socket.on('disconnect', () => {
    const userId = users.find(u => u.socketId === socket.id)?.socketId;
    if (userId) {
      users = users.filter(u => u.userId !== userId);
    }
    rooms.forEach(room => {
      room.players = room.players.filter(player => player.playerId !== userId);
      if (room.players.length === 0) rooms = rooms.filter(r => r.id !== room.id);
      else room.players.forEach(p => io.to(users.find(u => u.userId === p.playerId)?.socketId).emit('roomUpdated', room));
    });
  });

  socket.on('getRoom', (roomId) => {
    const room = rooms.find(r => r.id === roomId);
  
    if (room) {
      io.to(socket.id).emit('roomData', room); // Send the room data to the requesting socket
    } else {
      io.to(socket.id).emit('roomNotFound', `Room with ID ${roomId} not found`); // Notify the client if the room doesn't exist
    }
  });
  
});

app.post('/subscribe', async (req, res) => {
  const { subscription, userId } = req.body;
  try {
    await pool.query(
      `INSERT INTO subscriptions (user_id, endpoint, expiration_time, p256dh_key, auth_key)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET endpoint = EXCLUDED.endpoint,
       expiration_time = EXCLUDED.expiration_time, p256dh_key = EXCLUDED.p256dh_key, auth_key = EXCLUDED.auth_key`,
      [userId, subscription.endpoint, subscription.expirationTime, subscription.keys.p256dh, subscription.keys.auth]
    );
    res.status(201).json({ message: 'Sottoscrizione aggiornata' });
  } catch (err) {
    res.status(500).json({ message: 'Errore nel salvataggio', error: err.message });
  }
});

function sendPushNotification(subscription, title, body) {
  webpush.sendNotification(subscription, JSON.stringify({ title, body }))
    .then(() => console.log('Notifica inviata!'))
    .catch(err => console.error('Errore:', err));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
