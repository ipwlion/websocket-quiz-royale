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

let users = {};

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

  socket.on('notification', async (friendId) => {
  
    // Controlla se l'amico è online tramite WebSocket
    if (users[friendId]) {
      const friendSocketId = users[data.friendId];  // Ottieni socket ID dell'amico
      console.log(`Sending notification to user ${friendId} with socket ID ${friendSocketId}`);
  
      // Invia la notifica tramite WebSocket
      io.to(friendSocketId).emit('notification', {
        message: `Hai ricevuto un messaggio: ${message}`,
      });
  
      console.log('Notification sent via WebSocket');
    } else {
      console.log('Friend is offline, attempting to send push notification');
  
      // Se l'amico è offline, invia una notifica push
      try {
        console.log('Friend is offline, attempting to send push notification', friendId, users[friendId]);
        const result = await pool.query(
          'SELECT * FROM subscriptions WHERE user_id = $1',
          [friendId]
        );
  
        if (result.rowCount > 0) {
          console.log('Push notification sent',result.rows[0]);
          const x = {endpoint: result.rows[0].endpoint,
          keys: {
              p256dh: result.rows[0].p256dh_key,
              auth: result.rows[0].auth_key,
          }}
          console.log('Push notification sent', x);
          sendPushNotification(x, 'Nuovo Messaggio', 'richiesta di amicizia');
          console.log('Push notification sent');
        } else {
          console.log('No subscription found for the friend');
        }
      } catch (err) {
        console.error('Error sending push notification:', err);
      }
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log('User disconnected');
  });

});


app.post('/subscribe', async (req, res) => {
  const { subscription, userId } = req.body;

  try {
    const { endpoint, expirationTime, keys } = subscription;
    const { p256dh, auth } = keys;

    // Upsert: inserisce o aggiorna la sottoscrizione nel database
    const result = await pool.query(
      `INSERT INTO subscriptions (user_id, endpoint, expiration_time, p256dh_key, auth_key)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id) 
      DO UPDATE
      SET
        endpoint = EXCLUDED.endpoint,
        expiration_time = EXCLUDED.expiration_time,
        p256dh_key = EXCLUDED.p256dh_key,
        auth_key = EXCLUDED.auth_key
      RETURNING *`,
      [userId, endpoint, expirationTime, p256dh, auth]
    );

    res.status(201).json({ message: 'Sottoscrizione salvata o aggiornata', subscription: result.rows[0] });
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