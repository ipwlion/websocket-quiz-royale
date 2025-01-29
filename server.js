const express = require('express');
const WebSocket = require('ws');
const app = express();
const port = 3000;

// Crea un server WebSocket
const wss = new WebSocket.Server({ noServer: true });

// Gestisci le connessioni WebSocket
wss.on('connection', (ws) => {
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

// Imposta il server Express per gestire le richieste HTTP (se necessario)
app.server = app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
