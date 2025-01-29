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
app.use(cors());

// Middleware
app.use(morgan('combined'));
app.use(express.json());

// Routes
app.use('/auth', authRoutes);

// Error Handling Middleware
app.use(errorHandler);

// Gestisci le connessioni WebSocket
io.on('connection', (ws) => {
  console.log('Client connected');
  
  // Ascolta i messaggi inviati dal client
  ws.on('message', (message) => {
    console.log('Received:', message);
    
    // Qui puoi implementare la logica per trasformare le tue chiamate API PHP in risposte
    if (message === 'getData') {
      // Esegui una logica o una chiamata API (come una richiesta HTTP o una funzione)
      const data = { message: 'Data from API' };
      ws.send(JSON.stringify(data)); // Invia i dati al client
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});


