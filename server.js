const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const morgan = require('morgan');
require('dotenv').config();
require('./src/utils/initDb');
const cors = require('cors');

const authRoutes = require('./src/routes/auth');
const errorHandler = require('./src/middleware/errorHandler');
const { pool } = require('./src/utils/db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const webpush = require('web-push');

webpush.setVapidDetails(
  'mailto:tuo@email.com',
  'BORD1xKlW2VpTt09le-kUumh_paB7Tf9eOqh4vjHDtE70IMV19mVWeA35gvI_uw9_NdmHLYb4DL5UCcYIsPQRDI',
  'u39L4Ib9MM9sfw9pfBnTPYhdIxdHzq13P_LYI1hWYBA'
);

app.use(cors());

// Middleware
app.use(morgan('combined'));
app.use(express.json());

// Routes
app.use('/auth', authRoutes);

// Error Handling Middleware
app.use(errorHandler);

// Gestisci le connessioni WebSocket
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('userLoggedIn', (userId) => {
    console.log(`User ${userId} logged in with socket ID ${socket.id}`);
    // Associa l'ID utente alla connessione WebSocket
    users[userId] = socket.id;
  });
  // Unisci l'utente a una stanza
  socket.on('joinRoom', (data) => {
    const { userId, roomId } = data;
    socket.join(roomId);
    console.log(`User ${userId} joined room ${roomId}`);
    // Invia una risposta al client
    io.to(roomId).emit('room update', rooms[roomId]);
  });

  // Creazione di una stanza
  socket.on('createRoom', (data) => {
    const { userId } = data;
    const roomId = `room_${Date.now()}`;
    rooms[roomId] = { id: roomId, players: [userId] };
    console.log(`Room created: ${roomId}`);
    socket.join(roomId);
    io.emit('roomCreated', rooms[roomId]);
  });

  // Invia un messaggio a una stanza
  socket.on('sendMessage', (data) => {
    const { userId, roomId, message } = data;
    console.log(`Message from ${userId} in room ${roomId}: ${message}`);
    io.to(roomId).emit('newMessage', { userId, message });
  });

  // Trova un avversario
  socket.on('findOpponent', (userId) => {
    console.log(`Finding opponent for ${userId}`);
    // Logica per trovare un avversario
    io.emit('opponentFound', { userId, opponent: 'opponent data' });
  });

  // Aggiorna la stanza
  socket.on('updateRoom', (settings) => {
    const { roomId, newSettings } = settings;
    rooms[roomId] = { ...rooms[roomId], ...newSettings };
    io.to(roomId).emit('roomUpdated', rooms[roomId]);
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log('User disconnected');
  });

  socket.on('message', (message) => {
      console.log('Received:', message);

      // Invia una notifica Web Push a tutti gli iscritti
      subscriptions.forEach(subscription => {
          sendPushNotification(subscription, 'Nuovo Messaggio', `Hai ricevuto: ${message}`);
      });
  });

});


// Sottoscrizione delle notifiche
app.post('/subscribe', async (req, res) => {
  const { subscription, userId } = req.body;

  try {
    // Salva la sottoscrizione nel database
    const result = await pool.query(
      'INSERT INTO subscriptions (user_id, subscription) VALUES ($1, $2) RETURNING *',
      [userId, JSON.stringify(subscription)]
    );
    res.status(201).json({ message: 'Sottoscrizione salvata', subscription: result.rows[0] });
  } catch (err) {
    res.status(500).json({ message: 'Errore nel salvare la sottoscrizione', error: err.message });
  }
});


function sendPushNotification(subscription, title, body) {
  const payload = JSON.stringify({ title, body });

  webpush.sendNotification(subscription, payload)
      .then(() => console.log('Notifica inviata!'))
      .catch(err => console.error('Errore:', err));
}

// Start Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});