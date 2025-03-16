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
        // Controlla se l'utente esiste già nella lista
        const existingUserIndex = users.findIndex(u => u.userId === userId.userId);

        if (existingUserIndex !== -1) {
            // Rimuove il vecchio utente dalla lista per evitare duplicati
            users.splice(existingUserIndex, 1);
            console.log(`Vecchio socket rimosso per l'utente ${userId.userId}`);
        }

        // Aggiunge il nuovo socketId
        users.push({ userId: userId.userId, socketId: socket.id });
        console.log(`User ${userId.userId} associato al socket ${socket.id}`);
    });


    socket.on('createRoom', ({ userId, userName }) => {
        const roomId = `room_${Date.now()}`;
        const newRoom = { id: roomId, players: [{ playerId: userId, playerName: userName, isCreator: true }], status: 'waiting' };
        rooms.push(newRoom);
        io.to(socket.id).emit('roomCreated', newRoom);
    });

    socket.on('deleteRoom', ({ id }) => {
        console.log('room deleted', id);
        rooms = rooms.filter(r => r.id !== id);
        io.to(socket.id).emit('roomDeleted', 'OK');
    });

    socket.on('joinRoom', ({ userId, userName, roomId }) => {
        const room = rooms.find(r => r.id === roomId);
        if (room && room.players.length < 5 || room?.players.find(x => x.playerId === userId)) {
            if (!room?.players.find(x => x.playerId === userId)) {
                room.players.push({ playerId: userId, playerName: userName, isCreator: false });
                room.players.forEach(player => io.to(users.find(u => u.userId === player.playerId)?.socketId).emit('roomUpdated', room));
            } else {
                io.to(socket.id).emit('alreadyInRoom', room);
            }
        } else {
            io.to(socket.id).emit('roomFull', `Stanza ${roomId} piena o inesistente.`);
        }
    });

    socket.on('getProfile', async ({ userId }) => {
        try {
            const user = await pool.query(
                `SELECT id, username FROM users WHERE id = $1`,
                [userId]
            );
    
            if (user.rowCount > 0) {
                io.to(socket.id).emit('profileData', user.rows[0]);
            } else {
                io.to(socket.id).emit('profileError', { message: "Utente non trovato" });
            }
        } catch (err) {
            console.error('Errore nel recuperare il profilo:', err);
            io.to(socket.id).emit('profileError', { message: "Errore nel recupero profilo" });
        }
    });
    


    socket.on('sendFriendRequest', async ({ senderId, receiverId }) => {
        try {
            // Controlla se la richiesta già esiste
            const existingRequest = await pool.query(
                `SELECT * FROM friend_requests WHERE sender_id = $1 AND receiver_id = $2`, 
                [senderId, receiverId]
            );
    
            if (existingRequest.rowCount > 0) {
                io.to(socket.id).emit('friendRequestAlreadySent', { receiverId });
                return;
            }
    
            // Inserisci la richiesta di amicizia
            await pool.query(
                `INSERT INTO friend_requests (sender_id, receiver_id, status) VALUES ($1, $2, 'pending')`,
                [senderId, receiverId]
            );
    
            // Notifica il destinatario se è online
            const receiver = users.find(u => u.userId === receiverId);
            if (receiver) {
                console.log(`📩 [SERVER] Nuova richiesta di amicizia inviata a ${receiverId}`);
                io.to(receiver.socketId).emit('newFriendRequest', { senderId });
            }
            
            // ✅ Invio della notifica anche all'utente che ha inviato la richiesta
            io.to(socket.id).emit('friendRequestSent', { receiverId });
    
        } catch (err) {
            console.error('❌ Errore nell\'invio della richiesta di amicizia:', err);
        }
    });

    socket.on('acceptFriendRequest', async ({ senderId, receiverId }) => {
        try {
            await pool.query(
                `UPDATE friend_requests SET status = 'accepted' WHERE sender_id = $1 AND receiver_id = $2`,
                [senderId, receiverId]
            );
    
            await pool.query(
                `INSERT INTO friends (user_id1, user_id2) VALUES ($1, $2)`,
                [senderId, receiverId]
            );
    
            // Notifica entrambi gli utenti
            const sender = users.find(u => u.userId === senderId);
            const receiver = users.find(u => u.userId === receiverId);
            
            if (sender) {
                io.to(sender.socketId).emit('friendRequestAccepted', { receiverId });
            }
            if (receiver) {
                io.to(receiver.socketId).emit('friendAdded', { friendId: senderId });
            }
    
            console.log(`✅ [SERVER] Amicizia confermata tra ${senderId} e ${receiverId}`);
    
        } catch (err) {
            console.error('❌ Errore nell\'accettare la richiesta:', err);
        }
    });

    socket.on('getFriendsList', async ({ userId }) => {
        try {
            const friends = await pool.query(
                `SELECT u.id, u.username FROM friends 
                 JOIN users u ON 
                     (friends.user_id1 = u.id OR friends.user_id2 = u.id)
                 WHERE 
                     (friends.user_id1 = $1 OR friends.user_id2 = $1)
                     AND u.id != $1`, // ✅ Esclude l'utente stesso dalla lista
                [userId]
            );
    
            console.log(`✅ [SERVER] Lista amici aggiornata per ${userId}:`, friends.rows);
            io.to(socket.id).emit('friendsList', friends.rows);
    
        } catch (err) {
            console.error('❌ Errore nel recuperare la lista amici:', err);
        }
    });

    socket.on('rejectFriendRequest', async ({ senderId, receiverId }) => {
        try {
            await pool.query(
                `DELETE FROM friend_requests WHERE sender_id = $1 AND receiver_id = $2`,
                [senderId, receiverId]
            );
    
            const sender = users.find(u => u.userId === senderId);
            if (sender) {
                console.log(`❌ [SERVER] Richiesta di amicizia rifiutata tra ${senderId} e ${receiverId}`);
                io.to(sender.socketId).emit('friendRequestRejected', { receiverId });
            }
    
        } catch (err) {
            console.error('❌ Errore nel rifiutare la richiesta:', err);
        }
    });

    socket.on('getFriendRequests', async ({ userId }) => {
        try {
            console.log(`📨 [SERVER] Recupero richieste di amicizia per l'utente ${userId}`);
    
            const requests = await pool.query(
                `SELECT u.id, u.username FROM friend_requests fr
                 JOIN users u ON fr.sender_id = u.id
                 WHERE fr.sender_id != $1 AND fr.status = 'pending'`,
                [userId]
            );
    
            console.log(`✅ [SERVER] Trovate ${requests.rowCount} richieste di amicizia per ${userId}`);
            io.to(socket.id).emit('friendRequests', requests.rows);
    
        } catch (err) {
            console.error('❌ Errore nel recupero delle richieste di amicizia:', err);
        }
    });
    
    socket.on('removeFriend', async ({ userId, friendId }) => {
        try {
            await pool.query(
                `DELETE FROM friends WHERE (user_id1 = $1 AND user_id2 = $2) OR (user_id1 = $2 AND user_id2 = $1)`,
                [userId, friendId]
            );
    
            const friend = users.find(u => u.userId === friendId);
            if (friend) {
                io.to(friend.socketId).emit('friendRemoved', { userId });
            }
            io.to(socket.id).emit('friendRemoved', { friendId });
        } catch (err) {
            console.error('Errore nel rimuovere l\'amico:', err);
        }
    });

    socket.on('sendMessage', ({ userId, roomId, message }) => {
        const room = rooms.find(r => r.id === roomId);
        if (room) {
            room.players.forEach(player => io.to(users.find(u => u.userId === player.playerId)?.socketId).emit('newMessage', { userId, message }));
        }
    });

    socket.on('saveGameResult', async ({ roomId, userId, firstname, correctAnswersCount, totalTime }) => {
        const room = rooms.find(r => r.id === roomId);
        if (!room) {
            io.to(socket.id).emit('error', 'Room not found');
            return;
        }

        // Se non esiste un array per i risultati, crealo
        if (!room.results) {
            room.results = [];
        }

        // Controlla se l'utente ha già inviato un risultato ed evita duplicati
        const existingResult = room.results.find(result => result.userId === userId);
        if (!existingResult) {
            const newResult = { userId, firstname, correctAnswersCount, totalTime };
            room.results.push(newResult);

            try {
                // Salva il risultato nel database
                await pool.query(
                    `INSERT INTO game_results (room_id, user_id, correct_answers, total_time)
                     VALUES ($1, $2, $3, $4)`,
                    [roomId, userId, correctAnswersCount, totalTime] // ✅ Ora il numero di valori è corretto
                );

                console.log(`Risultato salvato nel DB per ${userId} nella stanza ${roomId}`);

            } catch (err) {
                console.error('Errore nel salvataggio del risultato nel database:', err);
                io.to(socket.id).emit('error', 'Errore nel salvataggio del risultato');
            }
        }

        // Invia a tutti i giocatori i risultati aggiornati
        room.players.forEach(player => {
            io.to(users.find(u => u.userId === player.playerId)?.socketId).emit('gameResultsUpdated', room.results);
        });

        // **Controllo se tutti i giocatori hanno finito**
        if (room.results.length === room.players.length) {
            console.log(`Tutti i giocatori della stanza ${roomId} hanno terminato.`);

            // Invia un evento a tutti i giocatori della stanza
            room.players.forEach(player => {
                io.to(users.find(u => u.userId === player.playerId)?.socketId).emit('gameFinished', room.results);
            });

            // **Opzionale**: Eliminare i dati della stanza dopo la fine
            setTimeout(() => {
                rooms = rooms.filter(r => r.id !== roomId);
                console.log(`Stanza ${roomId} rimossa dopo la conclusione.`);
            }, 10000); // Rimuove la stanza dopo 10 secondi
        }
    });


    socket.on('notification', async (friendId) => {
  
        // Trova l'utente nell'array `users`
        const friend = users.find(u => u.userId === friendId);
      
        if (friend) {
          const friendSocketId = friend.socketId; // Ottieni socket ID corretto
          console.log(`Sending notification to user ${friendId} with socket ID ${friendSocketId}`);
      
          // Invia la notifica tramite WebSocket
          io.to(friendSocketId).emit('notification', {
            message: `Hai ricevuto un messaggio`,
          });
      
          console.log('Notification sent via WebSocket');
        } else {
          console.log('Friend is offline, attempting to send push notification');
      
          // Se l'amico è offline, invia una notifica push
          try {
            const result = await pool.query(
              `SELECT 
                 subscription->>'endpoint' AS endpoint, 
                 subscription->'keys'->>'p256dh' AS p256dh_key, 
                 subscription->'keys'->>'auth' AS auth_key 
               FROM subscriptions 
               WHERE user_id = $1`,
              [friendId]
            );
      
            if (result.rowCount > 0) {
              const sub = result.rows[0];
              const subscription = {
                endpoint: sub.endpoint,
                keys: {
                  p256dh: sub.p256dh_key,
                  auth: sub.auth_key,
                },
              };
      
              console.log('Push notification data:', subscription);
              sendPushNotification(subscription, 'Nuovo Messaggio', 'richiesta di amicizia');
              console.log('Push notification sent');
            } else {
              console.log('No subscription found for the friend');
            }
          } catch (err) {
            console.error('Error sending push notification:', err);
          }
        }
      });
      
    socket.on('exit', ({ userId, id }) => {
        rooms.forEach(room => {
            if (room.id === id) {
                room.players = room.players.filter(player => player.playerId !== userId);
                if (room.players.length === 0) rooms = rooms.filter(r => r.id !== room.id);
                else room.players.forEach(p => io.to(users.find(u => u.userId === p.playerId)?.socketId).emit('roomUpdated', room));
            }
        });
    });

    socket.on('getRooms', () => {
        // Respond with the list of rooms
        socket.emit('roomsData', rooms.filter(room => room.status !== 'started'));  // Send rooms data back to the client
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

    socket.on('getQuestions', ({ roomId, totalQuestions, category }) => {
        const room = rooms.find(r => r.id === roomId);

        if (!room) {
            io.to(socket.id).emit('roomNotFound', 'La stanza non esiste.');
            return;
        }

        // Se la stanza non ha già domande assegnate, le assegniamo ora
        if (!room.questions) {
            const allQuestions = category === 'Tutte le categorie' ? questionsMock : questionsMock.filter(q => q.category === category) || questionsMock; // Prende le domande della categoria richiesta
            const shuffled = allQuestions.sort(() => 0.5 - Math.random()); // Mischia le domande
            room.questions = shuffled.slice(0, totalQuestions); // Seleziona il numero richiesto
        }

        // Invia le stesse domande a tutti gli utenti della stanza
        io.to(socket.id).emit('questionsData', { questions: room.questions });
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
            `INSERT INTO subscriptions (user_id, subscription)
             VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET subscription = EXCLUDED.subscription`,
            [userId, JSON.stringify(subscription)]
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






const questionsMock = [
    {
        "id": 4887,
        "question_text": "Chi ha sviluppato la teoria della relatività?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 19644,
                "answer_text": "Albert Einstein",
                "is_correct": 1
            },
            {
                "answer_id": 19645,
                "answer_text": "Isaac Newton",
                "is_correct": 0
            },
            {
                "answer_id": 19646,
                "answer_text": "Galileo Galilei",
                "is_correct": 0
            },
            {
                "answer_id": 19647,
                "answer_text": "Nikola Tesla",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4970,
        "question_text": "Chi ha scritto '1984'?",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 19976,
                "answer_text": "George Orwell",
                "is_correct": 1
            },
            {
                "answer_id": 19977,
                "answer_text": "Aldous Huxley",
                "is_correct": 0
            },
            {
                "answer_id": 19978,
                "answer_text": "Ray Bradbury",
                "is_correct": 0
            },
            {
                "answer_id": 19979,
                "answer_text": "Jules Verne",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4974,
        "question_text": "Chi ha inventato il primo computer?",
        "category": "Tecnologia",
        "answers": [
            {
                "answer_id": 19992,
                "answer_text": "Charles Babbage",
                "is_correct": 1
            },
            {
                "answer_id": 19993,
                "answer_text": "Alan Turing",
                "is_correct": 0
            },
            {
                "answer_id": 19994,
                "answer_text": "Steve Jobs",
                "is_correct": 0
            },
            {
                "answer_id": 19995,
                "answer_text": "Bill Gates",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4929,
        "question_text": "Chi era il presidente degli USA durante la Seconda Guerra Mondiale?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 19812,
                "answer_text": "Franklin D. Roosevelt",
                "is_correct": 1
            },
            {
                "answer_id": 19813,
                "answer_text": "Harry Truman",
                "is_correct": 0
            },
            {
                "answer_id": 19814,
                "answer_text": "Dwight Eisenhower",
                "is_correct": 0
            },
            {
                "answer_id": 19815,
                "answer_text": "Theodore Roosevelt",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4982,
        "question_text": "Quanti giocatori ha una squadra di calcio?",
        "category": "Sport",
        "answers": [
            {
                "answer_id": 20024,
                "answer_text": "11",
                "is_correct": 1
            },
            {
                "answer_id": 20025,
                "answer_text": "10",
                "is_correct": 0
            },
            {
                "answer_id": 20026,
                "answer_text": "9",
                "is_correct": 0
            },
            {
                "answer_id": 20027,
                "answer_text": "12",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4923,
        "question_text": "Chi è l'autore de 'Il nome della rosa'?",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 19788,
                "answer_text": "Umberto Eco",
                "is_correct": 1
            },
            {
                "answer_id": 19789,
                "answer_text": "Alberto Moravia",
                "is_correct": 0
            },
            {
                "answer_id": 19790,
                "answer_text": "Giuseppe Tomasi di Lampedusa",
                "is_correct": 0
            },
            {
                "answer_id": 19791,
                "answer_text": "Luigi Pirandello",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4996,
        "question_text": "Come si chiama la nostra galassia?",
        "category": "Astronomia",
        "answers": [
            {
                "answer_id": 20080,
                "answer_text": "Via Lattea",
                "is_correct": 1
            },
            {
                "answer_id": 20081,
                "answer_text": "Andromeda",
                "is_correct": 0
            },
            {
                "answer_id": 20082,
                "answer_text": "Galassia Sombrero",
                "is_correct": 0
            },
            {
                "answer_id": 20083,
                "answer_text": "Messier 87",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4999,
        "question_text": "Qual è la capitale del Canada?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 20092,
                "answer_text": "Ottawa",
                "is_correct": 1
            },
            {
                "answer_id": 20093,
                "answer_text": "Toronto",
                "is_correct": 0
            },
            {
                "answer_id": 20094,
                "answer_text": "Vancouver",
                "is_correct": 0
            },
            {
                "answer_id": 20095,
                "answer_text": "Montreal",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4976,
        "question_text": "In che anno è caduto l'Impero Romano d'Occidente?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 20000,
                "answer_text": "476 d.C.",
                "is_correct": 1
            },
            {
                "answer_id": 20001,
                "answer_text": "1492",
                "is_correct": 0
            },
            {
                "answer_id": 20002,
                "answer_text": "1066",
                "is_correct": 0
            },
            {
                "answer_id": 20003,
                "answer_text": "800 d.C.",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4956,
        "question_text": "Chi ha dipinto la Gioconda?",
        "category": "Arte",
        "answers": [
            {
                "answer_id": 19920,
                "answer_text": "Leonardo da Vinci",
                "is_correct": 1
            },
            {
                "answer_id": 19921,
                "answer_text": "Michelangelo",
                "is_correct": 0
            },
            {
                "answer_id": 19922,
                "answer_text": "Raffaello",
                "is_correct": 0
            },
            {
                "answer_id": 19923,
                "answer_text": "Caravaggio",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5728,
        "question_text": "Qual è il fiume più lungo del mondo?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 24113,
                "answer_text": "Nilo",
                "is_correct": 1
            },
            {
                "answer_id": 24114,
                "answer_text": "Amazonas",
                "is_correct": 0
            },
            {
                "answer_id": 24115,
                "answer_text": "Yangtze",
                "is_correct": 0
            },
            {
                "answer_id": 24116,
                "answer_text": "Mississippi",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4995,
        "question_text": "Qual è l'organo più grande del corpo umano?",
        "category": "Biologia",
        "answers": [
            {
                "answer_id": 20076,
                "answer_text": "Pelle",
                "is_correct": 1
            },
            {
                "answer_id": 20077,
                "answer_text": "Fegato",
                "is_correct": 0
            },
            {
                "answer_id": 20078,
                "answer_text": "Cuore",
                "is_correct": 0
            },
            {
                "answer_id": 20079,
                "answer_text": "Cervello",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4943,
        "question_text": "Quale azienda ha sviluppato il sistema operativo Windows?",
        "category": "Tecnologia",
        "answers": [
            {
                "answer_id": 19868,
                "answer_text": "Microsoft",
                "is_correct": 1
            },
            {
                "answer_id": 19869,
                "answer_text": "Apple",
                "is_correct": 0
            },
            {
                "answer_id": 19870,
                "answer_text": "IBM",
                "is_correct": 0
            },
            {
                "answer_id": 19871,
                "answer_text": "Google",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4977,
        "question_text": "In quale città si trova la Cappella Sistina?",
        "category": "Arte",
        "answers": [
            {
                "answer_id": 20004,
                "answer_text": "Città del Vaticano",
                "is_correct": 1
            },
            {
                "answer_id": 20005,
                "answer_text": "Firenze",
                "is_correct": 0
            },
            {
                "answer_id": 20006,
                "answer_text": "Roma",
                "is_correct": 0
            },
            {
                "answer_id": 20007,
                "answer_text": "Milano",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4990,
        "question_text": "Qual è il simbolo chimico dell'oro?",
        "category": "Chimica",
        "answers": [
            {
                "answer_id": 20056,
                "answer_text": "Au",
                "is_correct": 1
            },
            {
                "answer_id": 20057,
                "answer_text": "Ag",
                "is_correct": 0
            },
            {
                "answer_id": 20058,
                "answer_text": "Fe",
                "is_correct": 0
            },
            {
                "answer_id": 20059,
                "answer_text": "Hg",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4984,
        "question_text": "Qual è il risultato di 7x8?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 20032,
                "answer_text": "56",
                "is_correct": 1
            },
            {
                "answer_id": 20033,
                "answer_text": "48",
                "is_correct": 0
            },
            {
                "answer_id": 20034,
                "answer_text": "64",
                "is_correct": 0
            },
            {
                "answer_id": 20035,
                "answer_text": "72",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4965,
        "question_text": "Chi ha composto la Quinta Sinfonia?",
        "category": "Musica",
        "answers": [
            {
                "answer_id": 19956,
                "answer_text": "Ludwig van Beethoven",
                "is_correct": 1
            },
            {
                "answer_id": 19957,
                "answer_text": "Wolfgang Amadeus Mozart",
                "is_correct": 0
            },
            {
                "answer_id": 19958,
                "answer_text": "Johann Sebastian Bach",
                "is_correct": 0
            },
            {
                "answer_id": 19959,
                "answer_text": "Franz Schubert",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4987,
        "question_text": "Qual è il più grande oceano della Terra?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 20044,
                "answer_text": "Oceano Pacifico",
                "is_correct": 1
            },
            {
                "answer_id": 20045,
                "answer_text": "Oceano Atlantico",
                "is_correct": 0
            },
            {
                "answer_id": 20046,
                "answer_text": "Oceano Indiano",
                "is_correct": 0
            },
            {
                "answer_id": 20047,
                "answer_text": "Oceano Artico",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4998,
        "question_text": "Chi ha scritto 'I promessi sposi'?",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 20088,
                "answer_text": "Alessandro Manzoni",
                "is_correct": 1
            },
            {
                "answer_id": 20089,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 20090,
                "answer_text": "Italo Svevo",
                "is_correct": 0
            },
            {
                "answer_id": 20091,
                "answer_text": "Gabriele D'Annunzio",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4991,
        "question_text": "Chi ha scoperto la penicillina?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20060,
                "answer_text": "Alexander Fleming",
                "is_correct": 1
            },
            {
                "answer_id": 20061,
                "answer_text": "Louis Pasteur",
                "is_correct": 0
            },
            {
                "answer_id": 20062,
                "answer_text": "Marie Curie",
                "is_correct": 0
            },
            {
                "answer_id": 20063,
                "answer_text": "Joseph Lister",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4979,
        "question_text": "Cosa descrive la seconda legge della termodinamica?",
        "category": "Fisica",
        "answers": [
            {
                "answer_id": 20012,
                "answer_text": "Aumento dell'entropia",
                "is_correct": 1
            },
            {
                "answer_id": 20013,
                "answer_text": "Conservazione dell'energia",
                "is_correct": 0
            },
            {
                "answer_id": 20014,
                "answer_text": "Relatività",
                "is_correct": 0
            },
            {
                "answer_id": 20015,
                "answer_text": "Massa ed energia",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4986,
        "question_text": "Come si chiama il processo con cui le piante producono ossigeno?",
        "category": "Biologia",
        "answers": [
            {
                "answer_id": 20040,
                "answer_text": "Fotosintesi",
                "is_correct": 1
            },
            {
                "answer_id": 20041,
                "answer_text": "Respirazione",
                "is_correct": 0
            },
            {
                "answer_id": 20042,
                "answer_text": "Fermentazione",
                "is_correct": 0
            },
            {
                "answer_id": 20043,
                "answer_text": "Evaporazione",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5000,
        "question_text": "Quale numero è il primo numero primo dopo 10?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 20096,
                "answer_text": "11",
                "is_correct": 1
            },
            {
                "answer_id": 20097,
                "answer_text": "12",
                "is_correct": 0
            },
            {
                "answer_id": 20098,
                "answer_text": "13",
                "is_correct": 0
            },
            {
                "answer_id": 20099,
                "answer_text": "14",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4993,
        "question_text": "Quale gas è essenziale per la respirazione umana?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20068,
                "answer_text": "Ossigeno",
                "is_correct": 1
            },
            {
                "answer_id": 20069,
                "answer_text": "Azoto",
                "is_correct": 0
            },
            {
                "answer_id": 20070,
                "answer_text": "Anidride Carbonica",
                "is_correct": 0
            },
            {
                "answer_id": 20071,
                "answer_text": "Elio",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4988,
        "question_text": "Quale strumento è tipico del jazz?",
        "category": "Musica",
        "answers": [
            {
                "answer_id": 20048,
                "answer_text": "Sassofono",
                "is_correct": 1
            },
            {
                "answer_id": 20049,
                "answer_text": "Violino",
                "is_correct": 0
            },
            {
                "answer_id": 20050,
                "answer_text": "Pianoforte",
                "is_correct": 0
            },
            {
                "answer_id": 20051,
                "answer_text": "Arpa",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4994,
        "question_text": "Quale metallo è liquido a temperatura ambiente?",
        "category": "Chimica",
        "answers": [
            {
                "answer_id": 20072,
                "answer_text": "Mercurio",
                "is_correct": 1
            },
            {
                "answer_id": 20073,
                "answer_text": "Piombo",
                "is_correct": 0
            },
            {
                "answer_id": 20074,
                "answer_text": "Alluminio",
                "is_correct": 0
            },
            {
                "answer_id": 20075,
                "answer_text": "Ferro",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4981,
        "question_text": "Dove si sono svolte le Olimpiadi del 2008?",
        "category": "Sport",
        "answers": [
            {
                "answer_id": 20020,
                "answer_text": "Pechino",
                "is_correct": 1
            },
            {
                "answer_id": 20021,
                "answer_text": "Atene",
                "is_correct": 0
            },
            {
                "answer_id": 20022,
                "answer_text": "Sydney",
                "is_correct": 0
            },
            {
                "answer_id": 20023,
                "answer_text": "Londra",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4962,
        "question_text": "Chi ha formulato la legge della gravitazione universale?",
        "category": "Fisica",
        "answers": [
            {
                "answer_id": 19944,
                "answer_text": "Isaac Newton",
                "is_correct": 1
            },
            {
                "answer_id": 19945,
                "answer_text": "Albert Einstein",
                "is_correct": 0
            },
            {
                "answer_id": 19946,
                "answer_text": "Galileo Galilei",
                "is_correct": 0
            },
            {
                "answer_id": 19947,
                "answer_text": "Stephen Hawking",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4997,
        "question_text": "Qual è il pianeta più grande del sistema solare?",
        "category": "Astronomia",
        "answers": [
            {
                "answer_id": 20084,
                "answer_text": "Giove",
                "is_correct": 1
            },
            {
                "answer_id": 20085,
                "answer_text": "Saturno",
                "is_correct": 0
            },
            {
                "answer_id": 20086,
                "answer_text": "Urano",
                "is_correct": 0
            },
            {
                "answer_id": 20087,
                "answer_text": "Nettuno",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5198,
        "question_text": "Quanto fa 12 × 12?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 20888,
                "answer_text": "144",
                "is_correct": 0
            },
            {
                "answer_id": 20889,
                "answer_text": "124",
                "is_correct": 1
            },
            {
                "answer_id": 20890,
                "answer_text": "132",
                "is_correct": 0
            },
            {
                "answer_id": 20891,
                "answer_text": "121",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5197,
        "question_text": "Quante medaglie d'oro ha vinto Usain Bolt alle Olimpiadi?",
        "category": "Sport",
        "answers": [
            {
                "answer_id": 20884,
                "answer_text": "10",
                "is_correct": 0
            },
            {
                "answer_id": 20885,
                "answer_text": "6",
                "is_correct": 1
            },
            {
                "answer_id": 20886,
                "answer_text": "9",
                "is_correct": 0
            },
            {
                "answer_id": 20887,
                "answer_text": "8",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5200,
        "question_text": "Chi ha dipinto 'L'ultima cena'?",
        "category": "Arte",
        "answers": [
            {
                "answer_id": 20896,
                "answer_text": "Caravaggio",
                "is_correct": 1
            },
            {
                "answer_id": 20897,
                "answer_text": "Leonardo da Vinci",
                "is_correct": 0
            },
            {
                "answer_id": 20898,
                "answer_text": "Michelangelo",
                "is_correct": 0
            },
            {
                "answer_id": 20899,
                "answer_text": "Raffaello",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5164,
        "question_text": "Chi ha scritto 'Il giovane Holden'?",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 20752,
                "answer_text": "Mark Twain",
                "is_correct": 0
            },
            {
                "answer_id": 20753,
                "answer_text": "Ernest Hemingway",
                "is_correct": 0
            },
            {
                "answer_id": 20754,
                "answer_text": "F. Scott Fitzgerald",
                "is_correct": 0
            },
            {
                "answer_id": 20755,
                "answer_text": "J.D. Salinger",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5168,
        "question_text": "Chi ha scoperto l'elettrone?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20768,
                "answer_text": "J.J. Thomson",
                "is_correct": 0
            },
            {
                "answer_id": 20769,
                "answer_text": "Ernest Rutherford",
                "is_correct": 0
            },
            {
                "answer_id": 20770,
                "answer_text": "Niels Bohr",
                "is_correct": 1
            },
            {
                "answer_id": 20771,
                "answer_text": "Isaac Newton",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5193,
        "question_text": "Qual è la galassia più vicina alla Via Lattea?",
        "category": "Astronomia",
        "answers": [
            {
                "answer_id": 20868,
                "answer_text": "Triangolo",
                "is_correct": 0
            },
            {
                "answer_id": 20869,
                "answer_text": "Andromeda",
                "is_correct": 1
            },
            {
                "answer_id": 20870,
                "answer_text": "Messier 87",
                "is_correct": 0
            },
            {
                "answer_id": 20871,
                "answer_text": "NGC 1300",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5199,
        "question_text": "In che anno è scoppiata la Rivoluzione Francese?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 20892,
                "answer_text": "1789",
                "is_correct": 0
            },
            {
                "answer_id": 20893,
                "answer_text": "1815",
                "is_correct": 1
            },
            {
                "answer_id": 20894,
                "answer_text": "1848",
                "is_correct": 0
            },
            {
                "answer_id": 20895,
                "answer_text": "1776",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5187,
        "question_text": "Chi ha composto 'L'inno alla gioia'?",
        "category": "Musica",
        "answers": [
            {
                "answer_id": 20844,
                "answer_text": "Ludwig van Beethoven",
                "is_correct": 0
            },
            {
                "answer_id": 20845,
                "answer_text": "Johann Sebastian Bach",
                "is_correct": 0
            },
            {
                "answer_id": 20846,
                "answer_text": "Franz Schubert",
                "is_correct": 0
            },
            {
                "answer_id": 20847,
                "answer_text": "Wolfgang Amadeus Mozart",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5191,
        "question_text": "Qual è il principale gas che respiriamo?",
        "category": "Biologia",
        "answers": [
            {
                "answer_id": 20860,
                "answer_text": "Elio",
                "is_correct": 0
            },
            {
                "answer_id": 20861,
                "answer_text": "Azoto",
                "is_correct": 1
            },
            {
                "answer_id": 20862,
                "answer_text": "Anidride carbonica",
                "is_correct": 0
            },
            {
                "answer_id": 20863,
                "answer_text": "Ossigeno",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5192,
        "question_text": "Qual è il monte più alto d'Europa?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 20864,
                "answer_text": "Monte Bianco",
                "is_correct": 0
            },
            {
                "answer_id": 20865,
                "answer_text": "Monte Elbrus",
                "is_correct": 1
            },
            {
                "answer_id": 20866,
                "answer_text": "Monte Rosa",
                "is_correct": 0
            },
            {
                "answer_id": 20867,
                "answer_text": "Monte Cervino",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5195,
        "question_text": "Qual è l'elemento chimico con simbolo K?",
        "category": "Chimica",
        "answers": [
            {
                "answer_id": 20876,
                "answer_text": "Potassio",
                "is_correct": 1
            },
            {
                "answer_id": 20877,
                "answer_text": "Ferro",
                "is_correct": 0
            },
            {
                "answer_id": 20878,
                "answer_text": "Krypton",
                "is_correct": 0
            },
            {
                "answer_id": 20879,
                "answer_text": "Calcio",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5175,
        "question_text": "Qual è l'unità di misura della resistenza elettrica?",
        "category": "Fisica",
        "answers": [
            {
                "answer_id": 20796,
                "answer_text": "Ohm",
                "is_correct": 0
            },
            {
                "answer_id": 20797,
                "answer_text": "Watt",
                "is_correct": 0
            },
            {
                "answer_id": 20798,
                "answer_text": "Ampere",
                "is_correct": 1
            },
            {
                "answer_id": 20799,
                "answer_text": "Volt",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5160,
        "question_text": "Chi ha inventato il World Wide Web?",
        "category": "Tecnologia",
        "answers": [
            {
                "answer_id": 20736,
                "answer_text": "Bill Gates",
                "is_correct": 0
            },
            {
                "answer_id": 20737,
                "answer_text": "Alan Turing",
                "is_correct": 1
            },
            {
                "answer_id": 20738,
                "answer_text": "Tim Berners-Lee",
                "is_correct": 0
            },
            {
                "answer_id": 20739,
                "answer_text": "Steve Jobs",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5300,
        "question_text": "Chi ha scritto 'Il conte di Montecristo'?",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 21000,
                "answer_text": "Alexandre Dumas",
                "is_correct": 1
            },
            {
                "answer_id": 21001,
                "answer_text": "Victor Hugo",
                "is_correct": 0
            },
            {
                "answer_id": 21002,
                "answer_text": "Gustave Flaubert",
                "is_correct": 0
            },
            {
                "answer_id": 21003,
                "answer_text": "Honoré de Balzac",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5609,
        "question_text": "Qual è la montagna più alta del mondo?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 23037,
                "answer_text": "Monte Everest",
                "is_correct": 1
            },
            {
                "answer_id": 23038,
                "answer_text": "Monte Kilimangiaro",
                "is_correct": 0
            },
            {
                "answer_id": 23039,
                "answer_text": "Monte McKinley",
                "is_correct": 0
            },
            {
                "answer_id": 23040,
                "answer_text": "Monte Elbrus",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5710,
        "question_text": "Chi ha scoperto l'America nel 1492?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 24041,
                "answer_text": "Cristoforo Colombo",
                "is_correct": 1
            },
            {
                "answer_id": 24042,
                "answer_text": "Amerigo Vespucci",
                "is_correct": 0
            },
            {
                "answer_id": 24043,
                "answer_text": "James Cook",
                "is_correct": 0
            },
            {
                "answer_id": 24044,
                "answer_text": "Ferdinando Magellano",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5303,
        "question_text": "Qual è la formula chimica dell'acqua?",
        "category": "Chimica",
        "answers": [
            {
                "answer_id": 21012,
                "answer_text": "H2O",
                "is_correct": 1
            },
            {
                "answer_id": 21013,
                "answer_text": "CO2",
                "is_correct": 0
            },
            {
                "answer_id": 21014,
                "answer_text": "O2",
                "is_correct": 0
            },
            {
                "answer_id": 21015,
                "answer_text": "H2SO4",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5304,
        "question_text": "Chi ha formulato la teoria della selezione naturale?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 21016,
                "answer_text": "Charles Darwin",
                "is_correct": 1
            },
            {
                "answer_id": 21017,
                "answer_text": "Gregor Mendel",
                "is_correct": 0
            },
            {
                "answer_id": 21018,
                "answer_text": "Louis Pasteur",
                "is_correct": 0
            },
            {
                "answer_id": 21019,
                "answer_text": "Isaac Newton",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5305,
        "question_text": "Qual è la velocità della luce nel vuoto?",
        "category": "Fisica",
        "answers": [
            {
                "answer_id": 21020,
                "answer_text": "299.792.458 m/s",
                "is_correct": 1
            },
            {
                "answer_id": 21021,
                "answer_text": "150.000.000 m/s",
                "is_correct": 0
            },
            {
                "answer_id": 21022,
                "answer_text": "3.000.000 m/s",
                "is_correct": 0
            },
            {
                "answer_id": 21023,
                "answer_text": "1.080.000.000 km/h",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5356,
        "question_text": "Chi ha dipinto 'La notte stellata'?",
        "category": "Arte",
        "answers": [
            {
                "answer_id": 21221,
                "answer_text": "Vincent van Gogh",
                "is_correct": 1
            },
            {
                "answer_id": 21222,
                "answer_text": "Claude Monet",
                "is_correct": 0
            },
            {
                "answer_id": 21223,
                "answer_text": "Pablo Picasso",
                "is_correct": 0
            },
            {
                "answer_id": 21224,
                "answer_text": "Edvard Munch",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5733,
        "question_text": "Chi ha composto la 'Nona Sinfonia'?",
        "category": "Musica",
        "answers": [
            {
                "answer_id": 24133,
                "answer_text": "Ludwig van Beethoven",
                "is_correct": 1
            },
            {
                "answer_id": 24134,
                "answer_text": "Wolfgang Amadeus Mozart",
                "is_correct": 0
            },
            {
                "answer_id": 24135,
                "answer_text": "Johann Sebastian Bach",
                "is_correct": 0
            },
            {
                "answer_id": 24136,
                "answer_text": "Franz Schubert",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5308,
        "question_text": "Qual è l'organo principale del sistema nervoso umano?",
        "category": "Biologia",
        "answers": [
            {
                "answer_id": 21032,
                "answer_text": "Cervello",
                "is_correct": 1
            },
            {
                "answer_id": 21033,
                "answer_text": "Cuore",
                "is_correct": 0
            },
            {
                "answer_id": 21034,
                "answer_text": "Polmoni",
                "is_correct": 0
            },
            {
                "answer_id": 21035,
                "answer_text": "Fegato",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5719,
        "question_text": "Chi ha inventato il telefono?",
        "category": "Tecnologia",
        "answers": [
            {
                "answer_id": 24077,
                "answer_text": "Alexander Graham Bell",
                "is_correct": 1
            },
            {
                "answer_id": 24078,
                "answer_text": "Nikola Tesla",
                "is_correct": 0
            },
            {
                "answer_id": 24079,
                "answer_text": "Thomas Edison",
                "is_correct": 0
            },
            {
                "answer_id": 24080,
                "answer_text": "Guglielmo Marconi",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5301,
        "question_text": "Chi ha scritto 'Delitto e castigo'?",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 21001,
                "answer_text": "Fëdor Dostoevskij",
                "is_correct": 1
            },
            {
                "answer_id": 21002,
                "answer_text": "Lev Tolstoj",
                "is_correct": 0
            },
            {
                "answer_id": 21003,
                "answer_text": "Nikolaj Gogol'",
                "is_correct": 0
            },
            {
                "answer_id": 21004,
                "answer_text": "Anton Čechov",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5302,
        "question_text": "Qual è la capitale della Mongolia?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21005,
                "answer_text": "Ulan Bator",
                "is_correct": 1
            },
            {
                "answer_id": 21006,
                "answer_text": "Astana",
                "is_correct": 0
            },
            {
                "answer_id": 21007,
                "answer_text": "Pechino",
                "is_correct": 0
            },
            {
                "answer_id": 21008,
                "answer_text": "Kabul",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5303,
        "question_text": "Chi ha formulato la legge di gravitazione universale?",
        "category": "Fisica",
        "answers": [
            {
                "answer_id": 21009,
                "answer_text": "Isaac Newton",
                "is_correct": 1
            },
            {
                "answer_id": 21010,
                "answer_text": "Galileo Galilei",
                "is_correct": 0
            },
            {
                "answer_id": 21011,
                "answer_text": "Albert Einstein",
                "is_correct": 0
            },
            {
                "answer_id": 21012,
                "answer_text": "Johannes Kepler",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5304,
        "question_text": "Chi ha scoperto il radio e il polonio?",
        "category": "Chimica",
        "answers": [
            {
                "answer_id": 21013,
                "answer_text": "Marie Curie",
                "is_correct": 1
            },
            {
                "answer_id": 21014,
                "answer_text": "Dmitrij Mendeleev",
                "is_correct": 0
            },
            {
                "answer_id": 21015,
                "answer_text": "Antoine Lavoisier",
                "is_correct": 0
            },
            {
                "answer_id": 21016,
                "answer_text": "Joseph Priestley",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5306,
        "question_text": "Quale pianeta è soprannominato il 'Pianeta Rosso'?",
        "category": "Astronomia",
        "answers": [
            {
                "answer_id": 21021,
                "answer_text": "Marte",
                "is_correct": 1
            },
            {
                "answer_id": 21022,
                "answer_text": "Venere",
                "is_correct": 0
            },
            {
                "answer_id": 21023,
                "answer_text": "Giove",
                "is_correct": 0
            },
            {
                "answer_id": 21024,
                "answer_text": "Saturno",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5711,
        "question_text": "Qual è l'elemento chimico con simbolo 'O'?",
        "category": "Chimica",
        "answers": [
            {
                "answer_id": 24045,
                "answer_text": "Ossigeno",
                "is_correct": 1
            },
            {
                "answer_id": 24046,
                "answer_text": "Oro",
                "is_correct": 0
            },
            {
                "answer_id": 24047,
                "answer_text": "Osmio",
                "is_correct": 0
            },
            {
                "answer_id": 24048,
                "answer_text": "Ozono",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5308,
        "question_text": "Qual è la radice quadrata di 144?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 21029,
                "answer_text": "12",
                "is_correct": 1
            },
            {
                "answer_id": 21030,
                "answer_text": "10",
                "is_correct": 0
            },
            {
                "answer_id": 21031,
                "answer_text": "14",
                "is_correct": 0
            },
            {
                "answer_id": 21032,
                "answer_text": "16",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5309,
        "question_text": "Qual è il continente con il maggior numero di paesi?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21033,
                "answer_text": "Africa",
                "is_correct": 1
            },
            {
                "answer_id": 21034,
                "answer_text": "Asia",
                "is_correct": 0
            },
            {
                "answer_id": 21035,
                "answer_text": "Europa",
                "is_correct": 0
            },
            {
                "answer_id": 21036,
                "answer_text": "America",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5737,
        "question_text": "Chi ha scritto 'La Divina Commedia'?",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 24149,
                "answer_text": "Dante Alighieri",
                "is_correct": 1
            },
            {
                "answer_id": 24150,
                "answer_text": "Francesco Petrarca",
                "is_correct": 0
            },
            {
                "answer_id": 24151,
                "answer_text": "Giovanni Boccaccio",
                "is_correct": 0
            },
            {
                "answer_id": 24152,
                "answer_text": "Niccolò Machiavelli",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5311,
        "question_text": "Quale oceano bagna le coste occidentali degli Stati Uniti?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21041,
                "answer_text": "Oceano Pacifico",
                "is_correct": 1
            },
            {
                "answer_id": 21042,
                "answer_text": "Oceano Atlantico",
                "is_correct": 0
            },
            {
                "answer_id": 21043,
                "answer_text": "Oceano Indiano",
                "is_correct": 0
            },
            {
                "answer_id": 21044,
                "answer_text": "Oceano Artico",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5734,
        "question_text": "Qual è il pianeta più vicino al Sole?",
        "category": "Astronomia",
        "answers": [
            {
                "answer_id": 24137,
                "answer_text": "Mercurio",
                "is_correct": 1
            },
            {
                "answer_id": 24138,
                "answer_text": "Venere",
                "is_correct": 0
            },
            {
                "answer_id": 24139,
                "answer_text": "Marte",
                "is_correct": 0
            },
            {
                "answer_id": 24140,
                "answer_text": "Terra",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5314,
        "question_text": "Quale sport è associato a Roger Federer?",
        "category": "Sport",
        "answers": [
            {
                "answer_id": 21053,
                "answer_text": "Tennis",
                "is_correct": 1
            },
            {
                "answer_id": 21054,
                "answer_text": "Calcio",
                "is_correct": 0
            },
            {
                "answer_id": 21055,
                "answer_text": "Basket",
                "is_correct": 0
            },
            {
                "answer_id": 21056,
                "answer_text": "Golf",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5315,
        "question_text": "Chi ha scoperto la gravità dopo aver visto cadere una mela?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 21057,
                "answer_text": "Isaac Newton",
                "is_correct": 1
            },
            {
                "answer_id": 21058,
                "answer_text": "Albert Einstein",
                "is_correct": 0
            },
            {
                "answer_id": 21059,
                "answer_text": "Galileo Galilei",
                "is_correct": 0
            },
            {
                "answer_id": 21060,
                "answer_text": "Nikola Tesla",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5316,
        "question_text": "Quale nazione ha vinto il mondiale di calcio FIFA 2018?",
        "category": "Sport",
        "answers": [
            {
                "answer_id": 21061,
                "answer_text": "Francia",
                "is_correct": 1
            },
            {
                "answer_id": 21062,
                "answer_text": "Germania",
                "is_correct": 0
            },
            {
                "answer_id": 21063,
                "answer_text": "Brasile",
                "is_correct": 0
            },
            {
                "answer_id": 21064,
                "answer_text": "Argentina",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5317,
        "question_text": "Chi è il fondatore di Microsoft?",
        "category": "Tecnologia",
        "answers": [
            {
                "answer_id": 21065,
                "answer_text": "Bill Gates",
                "is_correct": 1
            },
            {
                "answer_id": 21066,
                "answer_text": "Steve Jobs",
                "is_correct": 0
            },
            {
                "answer_id": 21067,
                "answer_text": "Elon Musk",
                "is_correct": 0
            },
            {
                "answer_id": 21068,
                "answer_text": "Mark Zuckerberg",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5318,
        "question_text": "Quale gas compone la maggior parte dell'atmosfera terrestre?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 21069,
                "answer_text": "Azoto",
                "is_correct": 1
            },
            {
                "answer_id": 21070,
                "answer_text": "Ossigeno",
                "is_correct": 0
            },
            {
                "answer_id": 21071,
                "answer_text": "Anidride carbonica",
                "is_correct": 0
            },
            {
                "answer_id": 21072,
                "answer_text": "Idrogeno",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5727,
        "question_text": "Qual è la moneta ufficiale del Regno Unito?",
        "category": "Economia",
        "answers": [
            {
                "answer_id": 24109,
                "answer_text": "Sterlina",
                "is_correct": 1
            },
            {
                "answer_id": 24110,
                "answer_text": "Euro",
                "is_correct": 0
            },
            {
                "answer_id": 24111,
                "answer_text": "Dollaro",
                "is_correct": 0
            },
            {
                "answer_id": 24112,
                "answer_text": "Yen",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5320,
        "question_text": "Chi ha dipinto il soffitto della Cappella Sistina?",
        "category": "Arte",
        "answers": [
            {
                "answer_id": 21077,
                "answer_text": "Michelangelo",
                "is_correct": 1
            },
            {
                "answer_id": 21078,
                "answer_text": "Leonardo da Vinci",
                "is_correct": 0
            },
            {
                "answer_id": 21079,
                "answer_text": "Raffaello",
                "is_correct": 0
            },
            {
                "answer_id": 21080,
                "answer_text": "Caravaggio",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5322,
        "question_text": "Quale elemento chimico ha il simbolo 'O'?",
        "category": "Chimica",
        "answers": [
            {
                "answer_id": 21085,
                "answer_text": "Ossigeno",
                "is_correct": 1
            },
            {
                "answer_id": 21086,
                "answer_text": "Oro",
                "is_correct": 0
            },
            {
                "answer_id": 21087,
                "answer_text": "Osmio",
                "is_correct": 0
            },
            {
                "answer_id": 21088,
                "answer_text": "Olmio",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5323,
        "question_text": "In che anno è avvenuto il primo allunaggio?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 21089,
                "answer_text": "1969",
                "is_correct": 1
            },
            {
                "answer_id": 21090,
                "answer_text": "1958",
                "is_correct": 0
            },
            {
                "answer_id": 21091,
                "answer_text": "1975",
                "is_correct": 0
            },
            {
                "answer_id": 21092,
                "answer_text": "1982",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5324,
        "question_text": "Chi ha scritto 'Guerra e Pace'?",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 21093,
                "answer_text": "Lev Tolstoj",
                "is_correct": 1
            },
            {
                "answer_id": 21094,
                "answer_text": "Fëdor Dostoevskij",
                "is_correct": 0
            },
            {
                "answer_id": 21095,
                "answer_text": "Victor Hugo",
                "is_correct": 0
            },
            {
                "answer_id": 21096,
                "answer_text": "Jane Austen",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5325,
        "question_text": "Qual è il simbolo chimico dell'argento?",
        "category": "Chimica",
        "answers": [
            {
                "answer_id": 21097,
                "answer_text": "Ag",
                "is_correct": 1
            },
            {
                "answer_id": 21098,
                "answer_text": "Au",
                "is_correct": 0
            },
            {
                "answer_id": 21099,
                "answer_text": "Si",
                "is_correct": 0
            },
            {
                "answer_id": 21100,
                "answer_text": "Al",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5326,
        "question_text": "Chi ha fondato Tesla?",
        "category": "Tecnologia",
        "answers": [
            {
                "answer_id": 21101,
                "answer_text": "Elon Musk",
                "is_correct": 1
            },
            {
                "answer_id": 21102,
                "answer_text": "Steve Jobs",
                "is_correct": 0
            },
            {
                "answer_id": 21103,
                "answer_text": "Jeff Bezos",
                "is_correct": 0
            },
            {
                "answer_id": 21104,
                "answer_text": "Bill Gates",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5327,
        "question_text": "Dove si trova la Torre Eiffel?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21105,
                "answer_text": "Parigi",
                "is_correct": 1
            },
            {
                "answer_id": 21106,
                "answer_text": "Londra",
                "is_correct": 0
            },
            {
                "answer_id": 21107,
                "answer_text": "Roma",
                "is_correct": 0
            },
            {
                "answer_id": 21108,
                "answer_text": "Berlino",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5328,
        "question_text": "Qual è il colore del sangue ricco di ossigeno?",
        "category": "Biologia",
        "answers": [
            {
                "answer_id": 21109,
                "answer_text": "Rosso vivo",
                "is_correct": 1
            },
            {
                "answer_id": 21110,
                "answer_text": "Blu",
                "is_correct": 0
            },
            {
                "answer_id": 21111,
                "answer_text": "Verde",
                "is_correct": 0
            },
            {
                "answer_id": 21112,
                "answer_text": "Viola",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5329,
        "question_text": "Quanti continenti ci sono sulla Terra?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21113,
                "answer_text": "7",
                "is_correct": 1
            },
            {
                "answer_id": 21114,
                "answer_text": "6",
                "is_correct": 0
            },
            {
                "answer_id": 21115,
                "answer_text": "5",
                "is_correct": 0
            },
            {
                "answer_id": 21116,
                "answer_text": "8",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5608,
        "question_text": "Chi ha scritto 'Il piccolo principe'?",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 23033,
                "answer_text": "Antoine de Saint-Exupéry",
                "is_correct": 1
            },
            {
                "answer_id": 23034,
                "answer_text": "Victor Hugo",
                "is_correct": 0
            },
            {
                "answer_id": 23035,
                "answer_text": "Jules Verne",
                "is_correct": 0
            },
            {
                "answer_id": 23036,
                "answer_text": "Albert Camus",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5386,
        "question_text": "Qual è la valuta ufficiale del Giappone?",
        "category": "Economia",
        "answers": [
            {
                "answer_id": 21341,
                "answer_text": "Yen",
                "is_correct": 1
            },
            {
                "answer_id": 21342,
                "answer_text": "Won",
                "is_correct": 0
            },
            {
                "answer_id": 21343,
                "answer_text": "Dollaro",
                "is_correct": 0
            },
            {
                "answer_id": 21344,
                "answer_text": "Euro",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5332,
        "question_text": "Quale squadra ha vinto il mondiale di calcio nel 2018?",
        "category": "Sport",
        "answers": [
            {
                "answer_id": 21125,
                "answer_text": "Francia",
                "is_correct": 1
            },
            {
                "answer_id": 21126,
                "answer_text": "Germania",
                "is_correct": 0
            },
            {
                "answer_id": 21127,
                "answer_text": "Brasile",
                "is_correct": 0
            },
            {
                "answer_id": 21128,
                "answer_text": "Argentina",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5604,
        "question_text": "Chi ha scoperto l'America?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 23017,
                "answer_text": "Cristoforo Colombo",
                "is_correct": 1
            },
            {
                "answer_id": 23018,
                "answer_text": "Marco Polo",
                "is_correct": 0
            },
            {
                "answer_id": 23019,
                "answer_text": "Amerigo Vespucci",
                "is_correct": 0
            },
            {
                "answer_id": 23020,
                "answer_text": "James Cook",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5334,
        "question_text": "Quanti pianeti ci sono nel sistema solare?",
        "category": "Astronomia",
        "answers": [
            {
                "answer_id": 21133,
                "answer_text": "8",
                "is_correct": 1
            },
            {
                "answer_id": 21134,
                "answer_text": "9",
                "is_correct": 0
            },
            {
                "answer_id": 21135,
                "answer_text": "10",
                "is_correct": 0
            },
            {
                "answer_id": 21136,
                "answer_text": "7",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5702,
        "question_text": "Qual è la capitale dell'Australia?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 24009,
                "answer_text": "Canberra",
                "is_correct": 1
            },
            {
                "answer_id": 24010,
                "answer_text": "Sydney",
                "is_correct": 0
            },
            {
                "answer_id": 24011,
                "answer_text": "Melbourne",
                "is_correct": 0
            },
            {
                "answer_id": 24012,
                "answer_text": "Brisbane",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5336,
        "question_text": "Chi ha scritto la teoria dell'evoluzione?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 21141,
                "answer_text": "Charles Darwin",
                "is_correct": 1
            },
            {
                "answer_id": 21142,
                "answer_text": "Gregor Mendel",
                "is_correct": 0
            },
            {
                "answer_id": 21143,
                "answer_text": "Louis Pasteur",
                "is_correct": 0
            },
            {
                "answer_id": 21144,
                "answer_text": "Stephen Hawking",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5337,
        "question_text": "Chi ha scritto 'La divina commedia'?",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 21145,
                "answer_text": "Dante Alighieri",
                "is_correct": 1
            },
            {
                "answer_id": 21146,
                "answer_text": "Giovanni Boccaccio",
                "is_correct": 0
            },
            {
                "answer_id": 21147,
                "answer_text": "Francesco Petrarca",
                "is_correct": 0
            },
            {
                "answer_id": 21148,
                "answer_text": "Ludovico Ariosto",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5338,
        "question_text": "Quale metallo è più leggero?",
        "category": "Chimica",
        "answers": [
            {
                "answer_id": 21149,
                "answer_text": "Litio",
                "is_correct": 1
            },
            {
                "answer_id": 21150,
                "answer_text": "Alluminio",
                "is_correct": 0
            },
            {
                "answer_id": 21151,
                "answer_text": "Ferro",
                "is_correct": 0
            },
            {
                "answer_id": 21152,
                "answer_text": "Rame",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5339,
        "question_text": "Chi ha vinto il Premio Nobel per la pace nel 1993?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 21153,
                "answer_text": "Nelson Mandela",
                "is_correct": 1
            },
            {
                "answer_id": 21154,
                "answer_text": "Barack Obama",
                "is_correct": 0
            },
            {
                "answer_id": 21155,
                "answer_text": "Mahatma Gandhi",
                "is_correct": 0
            },
            {
                "answer_id": 21156,
                "answer_text": "Martin Luther King Jr.",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5340,
        "question_text": "Chi ha dipinto 'La nascita di Venere'?",
        "category": "Arte",
        "answers": [
            {
                "answer_id": 21157,
                "answer_text": "Sandro Botticelli",
                "is_correct": 1
            },
            {
                "answer_id": 21158,
                "answer_text": "Leonardo da Vinci",
                "is_correct": 0
            },
            {
                "answer_id": 21159,
                "answer_text": "Michelangelo",
                "is_correct": 0
            },
            {
                "answer_id": 21160,
                "answer_text": "Raffaello",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5341,
        "question_text": "Quale animale è noto per la sua capacità di mimetizzarsi?",
        "category": "Biologia",
        "answers": [
            {
                "answer_id": 21161,
                "answer_text": "Camaleonte",
                "is_correct": 1
            },
            {
                "answer_id": 21162,
                "answer_text": "Leopardo",
                "is_correct": 0
            },
            {
                "answer_id": 21163,
                "answer_text": "Polpo",
                "is_correct": 0
            },
            {
                "answer_id": 21164,
                "answer_text": "Geco",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5342,
        "question_text": "Chi ha scritto 'Orgoglio e pregiudizio'?",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 21165,
                "answer_text": "Jane Austen",
                "is_correct": 1
            },
            {
                "answer_id": 21166,
                "answer_text": "Charlotte Brontë",
                "is_correct": 0
            },
            {
                "answer_id": 21167,
                "answer_text": "Emily Brontë",
                "is_correct": 0
            },
            {
                "answer_id": 21168,
                "answer_text": "Virginia Woolf",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5390,
        "question_text": "Quale pianeta del sistema solare ha gli anelli più visibili?",
        "category": "Astronomia",
        "answers": [
            {
                "answer_id": 21357,
                "answer_text": "Saturno",
                "is_correct": 1
            },
            {
                "answer_id": 21358,
                "answer_text": "Giove",
                "is_correct": 0
            },
            {
                "answer_id": 21359,
                "answer_text": "Urano",
                "is_correct": 0
            },
            {
                "answer_id": 21360,
                "answer_text": "Nettuno",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5344,
        "question_text": "Quale gas viene usato nei palloncini per farli galleggiare?",
        "category": "Chimica",
        "answers": [
            {
                "answer_id": 21173,
                "answer_text": "Elio",
                "is_correct": 1
            },
            {
                "answer_id": 21174,
                "answer_text": "Azoto",
                "is_correct": 0
            },
            {
                "answer_id": 21175,
                "answer_text": "Ossigeno",
                "is_correct": 0
            },
            {
                "answer_id": 21176,
                "answer_text": "Idrogeno",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5345,
        "question_text": "Chi è il fondatore di Tesla?",
        "category": "Tecnologia",
        "answers": [
            {
                "answer_id": 21177,
                "answer_text": "Elon Musk",
                "is_correct": 1
            },
            {
                "answer_id": 21178,
                "answer_text": "Steve Jobs",
                "is_correct": 0
            },
            {
                "answer_id": 21179,
                "answer_text": "Bill Gates",
                "is_correct": 0
            },
            {
                "answer_id": 21180,
                "answer_text": "Jeff Bezos",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5346,
        "question_text": "Quale nazione ha ospitato i Giochi Olimpici del 2004?",
        "category": "Sport",
        "answers": [
            {
                "answer_id": 21181,
                "answer_text": "Grecia",
                "is_correct": 1
            },
            {
                "answer_id": 21182,
                "answer_text": "Cina",
                "is_correct": 0
            },
            {
                "answer_id": 21183,
                "answer_text": "Stati Uniti",
                "is_correct": 0
            },
            {
                "answer_id": 21184,
                "answer_text": "Brasile",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5735,
        "question_text": "Qual è il simbolo chimico del sodio?",
        "category": "Chimica",
        "answers": [
            {
                "answer_id": 24141,
                "answer_text": "Na",
                "is_correct": 1
            },
            {
                "answer_id": 24142,
                "answer_text": "S",
                "is_correct": 0
            },
            {
                "answer_id": 24143,
                "answer_text": "Sn",
                "is_correct": 0
            },
            {
                "answer_id": 24144,
                "answer_text": "So",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5348,
        "question_text": "Chi ha composto 'Le quattro stagioni'?",
        "category": "Musica",
        "answers": [
            {
                "answer_id": 21189,
                "answer_text": "Antonio Vivaldi",
                "is_correct": 1
            },
            {
                "answer_id": 21190,
                "answer_text": "Johann Sebastian Bach",
                "is_correct": 0
            },
            {
                "answer_id": 21191,
                "answer_text": "Ludwig van Beethoven",
                "is_correct": 0
            },
            {
                "answer_id": 21192,
                "answer_text": "Wolfgang Amadeus Mozart",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5349,
        "question_text": "Quale elemento chimico ha il numero atomico 1?",
        "category": "Chimica",
        "answers": [
            {
                "answer_id": 21193,
                "answer_text": "Idrogeno",
                "is_correct": 1
            },
            {
                "answer_id": 21194,
                "answer_text": "Ossigeno",
                "is_correct": 0
            },
            {
                "answer_id": 21195,
                "answer_text": "Elio",
                "is_correct": 0
            },
            {
                "answer_id": 21196,
                "answer_text": "Carbonio",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5371,
        "question_text": "Chi ha scritto 'Don Chisciotte della Mancia'?",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 21281,
                "answer_text": "Miguel de Cervantes",
                "is_correct": 1
            },
            {
                "answer_id": 21282,
                "answer_text": "Federico García Lorca",
                "is_correct": 0
            },
            {
                "answer_id": 21283,
                "answer_text": "Gabriel García Márquez",
                "is_correct": 0
            },
            {
                "answer_id": 21284,
                "answer_text": "Pablo Neruda",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5351,
        "question_text": "Qual è il fiume più lungo d'Italia?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21201,
                "answer_text": "Po",
                "is_correct": 1
            },
            {
                "answer_id": 21202,
                "answer_text": "Tevere",
                "is_correct": 0
            },
            {
                "answer_id": 21203,
                "answer_text": "Arno",
                "is_correct": 0
            },
            {
                "answer_id": 21204,
                "answer_text": "Adige",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5352,
        "question_text": "Quale nazione ha inventato la pizza?",
        "category": "Cucina",
        "answers": [
            {
                "answer_id": 21205,
                "answer_text": "Italia",
                "is_correct": 1
            },
            {
                "answer_id": 21206,
                "answer_text": "Francia",
                "is_correct": 0
            },
            {
                "answer_id": 21207,
                "answer_text": "Stati Uniti",
                "is_correct": 0
            },
            {
                "answer_id": 21208,
                "answer_text": "Spagna",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5701,
        "question_text": "Chi ha scoperto la gravità?",
        "category": "Fisica",
        "answers": [
            {
                "answer_id": 24005,
                "answer_text": "Isaac Newton",
                "is_correct": 1
            },
            {
                "answer_id": 24006,
                "answer_text": "Albert Einstein",
                "is_correct": 0
            },
            {
                "answer_id": 24007,
                "answer_text": "Galileo Galilei",
                "is_correct": 0
            },
            {
                "answer_id": 24008,
                "answer_text": "Niels Bohr",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5726,
        "question_text": "Qual è il simbolo chimico del ferro?",
        "category": "Chimica",
        "answers": [
            {
                "answer_id": 24105,
                "answer_text": "Fe",
                "is_correct": 1
            },
            {
                "answer_id": 24106,
                "answer_text": "F",
                "is_correct": 0
            },
            {
                "answer_id": 24107,
                "answer_text": "Ir",
                "is_correct": 0
            },
            {
                "answer_id": 24108,
                "answer_text": "Pb",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5357,
        "question_text": "Quanti elementi ha la tavola periodica?",
        "category": "Chimica",
        "answers": [
            {
                "answer_id": 21225,
                "answer_text": "118",
                "is_correct": 1
            },
            {
                "answer_id": 21226,
                "answer_text": "102",
                "is_correct": 0
            },
            {
                "answer_id": 21227,
                "answer_text": "110",
                "is_correct": 0
            },
            {
                "answer_id": 21228,
                "answer_text": "126",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5384,
        "question_text": "Chi ha fondato Microsoft?",
        "category": "Tecnologia",
        "answers": [
            {
                "answer_id": 21333,
                "answer_text": "Bill Gates e Paul Allen",
                "is_correct": 1
            },
            {
                "answer_id": 21334,
                "answer_text": "Steve Jobs e Steve Wozniak",
                "is_correct": 0
            },
            {
                "answer_id": 21335,
                "answer_text": "Larry Page e Sergey Brin",
                "is_correct": 0
            },
            {
                "answer_id": 21336,
                "answer_text": "Mark Zuckerberg",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5720,
        "question_text": "Qual è il paese più grande del mondo per superficie?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 24081,
                "answer_text": "Russia",
                "is_correct": 1
            },
            {
                "answer_id": 24082,
                "answer_text": "Canada",
                "is_correct": 0
            },
            {
                "answer_id": 24083,
                "answer_text": "Cina",
                "is_correct": 0
            },
            {
                "answer_id": 24084,
                "answer_text": "Stati Uniti",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5362,
        "question_text": "Chi ha scritto 'Guerra e pace'?",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 21245,
                "answer_text": "Lev Tolstoj",
                "is_correct": 1
            },
            {
                "answer_id": 21246,
                "answer_text": "Fëdor Dostoevskij",
                "is_correct": 0
            },
            {
                "answer_id": 21247,
                "answer_text": "Vladimir Nabokov",
                "is_correct": 0
            },
            {
                "answer_id": 21248,
                "answer_text": "Aleksandr Puškin",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5363,
        "question_text": "Qual è la moneta ufficiale del Giappone?",
        "category": "Economia",
        "answers": [
            {
                "answer_id": 21249,
                "answer_text": "Yen",
                "is_correct": 1
            },
            {
                "answer_id": 21250,
                "answer_text": "Won",
                "is_correct": 0
            },
            {
                "answer_id": 21251,
                "answer_text": "Renminbi",
                "is_correct": 0
            },
            {
                "answer_id": 21252,
                "answer_text": "Dollaro giapponese",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5365,
        "question_text": "Quale gas è usato nei palloncini per farli volare?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 21257,
                "answer_text": "Elio",
                "is_correct": 1
            },
            {
                "answer_id": 21258,
                "answer_text": "Azoto",
                "is_correct": 0
            },
            {
                "answer_id": 21259,
                "answer_text": "Ossigeno",
                "is_correct": 0
            },
            {
                "answer_id": 21260,
                "answer_text": "Idrogeno",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5367,
        "question_text": "In che anno è stata fondata Apple?",
        "category": "Tecnologia",
        "answers": [
            {
                "answer_id": 21265,
                "answer_text": "1976",
                "is_correct": 1
            },
            {
                "answer_id": 21266,
                "answer_text": "1980",
                "is_correct": 0
            },
            {
                "answer_id": 21267,
                "answer_text": "1995",
                "is_correct": 0
            },
            {
                "answer_id": 21268,
                "answer_text": "2001",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5369,
        "question_text": "Chi ha composto 'La Traviata'?",
        "category": "Musica",
        "answers": [
            {
                "answer_id": 21273,
                "answer_text": "Giuseppe Verdi",
                "is_correct": 1
            },
            {
                "answer_id": 21274,
                "answer_text": "Gioachino Rossini",
                "is_correct": 0
            },
            {
                "answer_id": 21275,
                "answer_text": "Wolfgang Amadeus Mozart",
                "is_correct": 0
            },
            {
                "answer_id": 21276,
                "answer_text": "Ludwig van Beethoven",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5370,
        "question_text": "Quale animale è noto per la sua capacità di rigenerare gli arti?",
        "category": "Biologia",
        "answers": [
            {
                "answer_id": 21277,
                "answer_text": "Salamandra",
                "is_correct": 1
            },
            {
                "answer_id": 21278,
                "answer_text": "Tartaruga",
                "is_correct": 0
            },
            {
                "answer_id": 21279,
                "answer_text": "Squalo",
                "is_correct": 0
            },
            {
                "answer_id": 21280,
                "answer_text": "Serpente",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5373,
        "question_text": "Quale paese è famoso per la Torre Eiffel?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21289,
                "answer_text": "Francia",
                "is_correct": 1
            },
            {
                "answer_id": 21290,
                "answer_text": "Italia",
                "is_correct": 0
            },
            {
                "answer_id": 21291,
                "answer_text": "Spagna",
                "is_correct": 0
            },
            {
                "answer_id": 21292,
                "answer_text": "Germania",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5703,
        "question_text": "Chi ha dipinto 'La Notte Stellata'?",
        "category": "Arte",
        "answers": [
            {
                "answer_id": 24013,
                "answer_text": "Vincent van Gogh",
                "is_correct": 1
            },
            {
                "answer_id": 24014,
                "answer_text": "Claude Monet",
                "is_correct": 0
            },
            {
                "answer_id": 24015,
                "answer_text": "Pablo Picasso",
                "is_correct": 0
            },
            {
                "answer_id": 24016,
                "answer_text": "Leonardo da Vinci",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5377,
        "question_text": "Quale animale è il più veloce sulla terra?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 21305,
                "answer_text": "Ghepardo",
                "is_correct": 1
            },
            {
                "answer_id": 21306,
                "answer_text": "Leone",
                "is_correct": 0
            },
            {
                "answer_id": 21307,
                "answer_text": "Cavallo",
                "is_correct": 0
            },
            {
                "answer_id": 21308,
                "answer_text": "Struzzo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5378,
        "question_text": "Chi ha scoperto la legge della gravitazione universale?",
        "category": "Fisica",
        "answers": [
            {
                "answer_id": 21309,
                "answer_text": "Isaac Newton",
                "is_correct": 1
            },
            {
                "answer_id": 21310,
                "answer_text": "Albert Einstein",
                "is_correct": 0
            },
            {
                "answer_id": 21311,
                "answer_text": "Galileo Galilei",
                "is_correct": 0
            },
            {
                "answer_id": 21312,
                "answer_text": "Stephen Hawking",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5379,
        "question_text": "Quale film ha vinto l'Oscar come miglior film nel 1997?",
        "category": "Cinema",
        "answers": [
            {
                "answer_id": 21313,
                "answer_text": "Titanic",
                "is_correct": 1
            },
            {
                "answer_id": 21314,
                "answer_text": "Forrest Gump",
                "is_correct": 0
            },
            {
                "answer_id": 21315,
                "answer_text": "Il Gladiatore",
                "is_correct": 0
            },
            {
                "answer_id": 21316,
                "answer_text": "Braveheart",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5381,
        "question_text": "Qual è il metallo più leggero?",
        "category": "Chimica",
        "answers": [
            {
                "answer_id": 21321,
                "answer_text": "Litio",
                "is_correct": 1
            },
            {
                "answer_id": 21322,
                "answer_text": "Alluminio",
                "is_correct": 0
            },
            {
                "answer_id": 21323,
                "answer_text": "Magnesio",
                "is_correct": 0
            },
            {
                "answer_id": 21324,
                "answer_text": "Titanio",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5382,
        "question_text": "Quale gas è responsabile dell'effetto serra?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 21325,
                "answer_text": "Anidride carbonica",
                "is_correct": 1
            },
            {
                "answer_id": 21326,
                "answer_text": "Azoto",
                "is_correct": 0
            },
            {
                "answer_id": 21327,
                "answer_text": "Ossigeno",
                "is_correct": 0
            },
            {
                "answer_id": 21328,
                "answer_text": "Elio",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5385,
        "question_text": "Quale animale è il più grande mammifero marino?",
        "category": "Biologia",
        "answers": [
            {
                "answer_id": 21337,
                "answer_text": "Balena blu",
                "is_correct": 1
            },
            {
                "answer_id": 21338,
                "answer_text": "Orca",
                "is_correct": 0
            },
            {
                "answer_id": 21339,
                "answer_text": "Delfino",
                "is_correct": 0
            },
            {
                "answer_id": 21340,
                "answer_text": "Squalo balena",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5387,
        "question_text": "Qual è la capitale della Spagna?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21345,
                "answer_text": "Madrid",
                "is_correct": 1
            },
            {
                "answer_id": 21346,
                "answer_text": "Barcellona",
                "is_correct": 0
            },
            {
                "answer_id": 21347,
                "answer_text": "Valencia",
                "is_correct": 0
            },
            {
                "answer_id": 21348,
                "answer_text": "Siviglia",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5388,
        "question_text": "Chi ha scoperto l'insulina?",
        "category": "Medicina",
        "answers": [
            {
                "answer_id": 21349,
                "answer_text": "Frederick Banting e Charles Best",
                "is_correct": 1
            },
            {
                "answer_id": 21350,
                "answer_text": "Alexander Fleming",
                "is_correct": 0
            },
            {
                "answer_id": 21351,
                "answer_text": "Louis Pasteur",
                "is_correct": 0
            },
            {
                "answer_id": 21352,
                "answer_text": "Marie Curie",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5389,
        "question_text": "Qual è la città più popolosa del mondo?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21353,
                "answer_text": "Tokyo",
                "is_correct": 1
            },
            {
                "answer_id": 21354,
                "answer_text": "New York",
                "is_correct": 0
            },
            {
                "answer_id": 21355,
                "answer_text": "Shanghai",
                "is_correct": 0
            },
            {
                "answer_id": 21356,
                "answer_text": "Mumbai",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5392,
        "question_text": "Qual è il simbolo chimico dell'idrogeno?",
        "category": "Chimica",
        "answers": [
            {
                "answer_id": 21365,
                "answer_text": "H",
                "is_correct": 1
            },
            {
                "answer_id": 21366,
                "answer_text": "O",
                "is_correct": 0
            },
            {
                "answer_id": 21367,
                "answer_text": "He",
                "is_correct": 0
            },
            {
                "answer_id": 21368,
                "answer_text": "N",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5393,
        "question_text": "In che anno è stata firmata la Dichiarazione di Indipendenza degli Stati Uniti?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 21369,
                "answer_text": "1776",
                "is_correct": 1
            },
            {
                "answer_id": 21370,
                "answer_text": "1789",
                "is_correct": 0
            },
            {
                "answer_id": 21371,
                "answer_text": "1812",
                "is_correct": 0
            },
            {
                "answer_id": 21372,
                "answer_text": "1754",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5704,
        "question_text": "Quale città ospita la Torre Eiffel?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 24017,
                "answer_text": "Parigi",
                "is_correct": 1
            },
            {
                "answer_id": 24018,
                "answer_text": "Londra",
                "is_correct": 0
            },
            {
                "answer_id": 24019,
                "answer_text": "Berlino",
                "is_correct": 0
            },
            {
                "answer_id": 24020,
                "answer_text": "Madrid",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5395,
        "question_text": "Chi ha scoperto la teoria della selezione naturale?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 21377,
                "answer_text": "Charles Darwin",
                "is_correct": 1
            },
            {
                "answer_id": 21378,
                "answer_text": "Gregor Mendel",
                "is_correct": 0
            },
            {
                "answer_id": 21379,
                "answer_text": "Alfred Wallace",
                "is_correct": 0
            },
            {
                "answer_id": 21380,
                "answer_text": "Jean-Baptiste Lamarck",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5396,
        "question_text": "Qual è il monte più alto del mondo?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21381,
                "answer_text": "Monte Everest",
                "is_correct": 1
            },
            {
                "answer_id": 21382,
                "answer_text": "Monte Kilimanjaro",
                "is_correct": 0
            },
            {
                "answer_id": 21383,
                "answer_text": "Monte McKinley",
                "is_correct": 0
            },
            {
                "answer_id": 21384,
                "answer_text": "Monte Elbrus",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5397,
        "question_text": "Chi ha scritto 'Don Chisciotte'?",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 21385,
                "answer_text": "Miguel de Cervantes",
                "is_correct": 1
            },
            {
                "answer_id": 21386,
                "answer_text": "William Shakespeare",
                "is_correct": 0
            },
            {
                "answer_id": 21387,
                "answer_text": "Dante Alighieri",
                "is_correct": 0
            },
            {
                "answer_id": 21388,
                "answer_text": "Victor Hugo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5398,
        "question_text": "Qual è il paese con il maggior numero di abitanti?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21389,
                "answer_text": "India",
                "is_correct": 1
            },
            {
                "answer_id": 21390,
                "answer_text": "Cina",
                "is_correct": 0
            },
            {
                "answer_id": 21391,
                "answer_text": "USA",
                "is_correct": 0
            },
            {
                "answer_id": 21392,
                "answer_text": "Indonesia",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5400,
        "question_text": "Quale città è conosciuta come 'la Grande Mela'?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21397,
                "answer_text": "New York",
                "is_correct": 1
            },
            {
                "answer_id": 21398,
                "answer_text": "Los Angeles",
                "is_correct": 0
            },
            {
                "answer_id": 21399,
                "answer_text": "Chicago",
                "is_correct": 0
            },
            {
                "answer_id": 21400,
                "answer_text": "San Francisco",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5724,
        "question_text": "Chi ha dipinto la Cappella Sistina?",
        "category": "Arte",
        "answers": [
            {
                "answer_id": 24097,
                "answer_text": "Michelangelo",
                "is_correct": 1
            },
            {
                "answer_id": 24098,
                "answer_text": "Raffaello",
                "is_correct": 0
            },
            {
                "answer_id": 24099,
                "answer_text": "Leonardo da Vinci",
                "is_correct": 0
            },
            {
                "answer_id": 24100,
                "answer_text": "Caravaggio",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5700,
        "question_text": "Qual è il gas più abbondante nell'atmosfera terrestre?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 24001,
                "answer_text": "Azoto",
                "is_correct": 1
            },
            {
                "answer_id": 24002,
                "answer_text": "Ossigeno",
                "is_correct": 0
            },
            {
                "answer_id": 24003,
                "answer_text": "Anidride carbonica",
                "is_correct": 0
            },
            {
                "answer_id": 24004,
                "answer_text": "Idrogeno",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5403,
        "question_text": "In che anno è caduto il Muro di Berlino?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 21409,
                "answer_text": "1989",
                "is_correct": 1
            },
            {
                "answer_id": 21410,
                "answer_text": "1991",
                "is_correct": 0
            },
            {
                "answer_id": 21411,
                "answer_text": "1985",
                "is_correct": 0
            },
            {
                "answer_id": 21412,
                "answer_text": "1979",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5721,
        "question_text": "Chi ha scritto 'Orgoglio e Pregiudizio'?",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 24085,
                "answer_text": "Jane Austen",
                "is_correct": 1
            },
            {
                "answer_id": 24086,
                "answer_text": "Charlotte Brontë",
                "is_correct": 0
            },
            {
                "answer_id": 24087,
                "answer_text": "Emily Brontë",
                "is_correct": 0
            },
            {
                "answer_id": 24088,
                "answer_text": "Virginia Woolf",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5406,
        "question_text": "Quante ossa ha il corpo umano adulto?",
        "category": "Biologia",
        "answers": [
            {
                "answer_id": 21421,
                "answer_text": "206",
                "is_correct": 1
            },
            {
                "answer_id": 21422,
                "answer_text": "210",
                "is_correct": 0
            },
            {
                "answer_id": 21423,
                "answer_text": "180",
                "is_correct": 0
            },
            {
                "answer_id": 21424,
                "answer_text": "250",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5722,
        "question_text": "Qual è la capitale del Giappone?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 24089,
                "answer_text": "Tokyo",
                "is_correct": 1
            },
            {
                "answer_id": 24090,
                "answer_text": "Kyoto",
                "is_correct": 0
            },
            {
                "answer_id": 24091,
                "answer_text": "Osaka",
                "is_correct": 0
            },
            {
                "answer_id": 24092,
                "answer_text": "Nagoya",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5718,
        "question_text": "Chi ha composto 'Il flauto magico'?",
        "category": "Musica",
        "answers": [
            {
                "answer_id": 24073,
                "answer_text": "Wolfgang Amadeus Mozart",
                "is_correct": 1
            },
            {
                "answer_id": 24074,
                "answer_text": "Ludwig van Beethoven",
                "is_correct": 0
            },
            {
                "answer_id": 24075,
                "answer_text": "Johann Sebastian Bach",
                "is_correct": 0
            },
            {
                "answer_id": 24076,
                "answer_text": "Franz Schubert",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5717,
        "question_text": "Quale pianeta è conosciuto come il 'Pianeta Rosso'?",
        "category": "Astronomia",
        "answers": [
            {
                "answer_id": 24069,
                "answer_text": "Marte",
                "is_correct": 1
            },
            {
                "answer_id": 24070,
                "answer_text": "Venere",
                "is_correct": 0
            },
            {
                "answer_id": 24071,
                "answer_text": "Giove",
                "is_correct": 0
            },
            {
                "answer_id": 24072,
                "answer_text": "Nettuno",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5716,
        "question_text": "Qual è l'animale terrestre più veloce?",
        "category": "Biologia",
        "answers": [
            {
                "answer_id": 24065,
                "answer_text": "Ghepardo",
                "is_correct": 1
            },
            {
                "answer_id": 24066,
                "answer_text": "Leopardo",
                "is_correct": 0
            },
            {
                "answer_id": 24067,
                "answer_text": "Cavallo",
                "is_correct": 0
            },
            {
                "answer_id": 24068,
                "answer_text": "Leone",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5603,
        "question_text": "Quale elemento chimico ha simbolo 'O'?",
        "category": "Chimica",
        "answers": [
            {
                "answer_id": 23013,
                "answer_text": "Ossigeno",
                "is_correct": 1
            },
            {
                "answer_id": 23014,
                "answer_text": "Oro",
                "is_correct": 0
            },
            {
                "answer_id": 23015,
                "answer_text": "Osmio",
                "is_correct": 0
            },
            {
                "answer_id": 23016,
                "answer_text": "Oganesson",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5605,
        "question_text": "Qual è la valuta del Giappone?",
        "category": "Economia",
        "answers": [
            {
                "answer_id": 23021,
                "answer_text": "Yen",
                "is_correct": 1
            },
            {
                "answer_id": 23022,
                "answer_text": "Won",
                "is_correct": 0
            },
            {
                "answer_id": 23023,
                "answer_text": "Peso",
                "is_correct": 0
            },
            {
                "answer_id": 23024,
                "answer_text": "Dollaro",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5606,
        "question_text": "Chi è stato il primo uomo a camminare sulla Luna?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 23025,
                "answer_text": "Neil Armstrong",
                "is_correct": 1
            },
            {
                "answer_id": 23026,
                "answer_text": "Buzz Aldrin",
                "is_correct": 0
            },
            {
                "answer_id": 23027,
                "answer_text": "Yuri Gagarin",
                "is_correct": 0
            },
            {
                "answer_id": 23028,
                "answer_text": "Michael Collins",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5607,
        "question_text": "Qual è il deserto più grande del mondo?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 23029,
                "answer_text": "Antartide",
                "is_correct": 1
            },
            {
                "answer_id": 23030,
                "answer_text": "Sahara",
                "is_correct": 0
            },
            {
                "answer_id": 23031,
                "answer_text": "Gobi",
                "is_correct": 0
            },
            {
                "answer_id": 23032,
                "answer_text": "Kalahari",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5705,
        "question_text": "Qual è il simbolo chimico dell'acqua?",
        "category": "Chimica",
        "answers": [
            {
                "answer_id": 24021,
                "answer_text": "H2O",
                "is_correct": 1
            },
            {
                "answer_id": 24022,
                "answer_text": "O2",
                "is_correct": 0
            },
            {
                "answer_id": 24023,
                "answer_text": "CO2",
                "is_correct": 0
            },
            {
                "answer_id": 24024,
                "answer_text": "H2",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5706,
        "question_text": "Quale paese ha la popolazione più numerosa?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 24025,
                "answer_text": "India",
                "is_correct": 1
            },
            {
                "answer_id": 24026,
                "answer_text": "Cina",
                "is_correct": 0
            },
            {
                "answer_id": 24027,
                "answer_text": "USA",
                "is_correct": 0
            },
            {
                "answer_id": 24028,
                "answer_text": "Russia",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5707,
        "question_text": "Qual è la moneta ufficiale dell'Unione Europea?",
        "category": "Economia",
        "answers": [
            {
                "answer_id": 24029,
                "answer_text": "Euro",
                "is_correct": 1
            },
            {
                "answer_id": 24030,
                "answer_text": "Dollaro",
                "is_correct": 0
            },
            {
                "answer_id": 24031,
                "answer_text": "Sterlina",
                "is_correct": 0
            },
            {
                "answer_id": 24032,
                "answer_text": "Franco svizzero",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5712,
        "question_text": "Quale strumento musicale ha 88 tasti?",
        "category": "Musica",
        "answers": [
            {
                "answer_id": 24049,
                "answer_text": "Pianoforte",
                "is_correct": 1
            },
            {
                "answer_id": 24050,
                "answer_text": "Chitarra",
                "is_correct": 0
            },
            {
                "answer_id": 24051,
                "answer_text": "Violino",
                "is_correct": 0
            },
            {
                "answer_id": 24052,
                "answer_text": "Flauto",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5713,
        "question_text": "Qual è il più grande deserto del mondo?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 24053,
                "answer_text": "Antartide",
                "is_correct": 1
            },
            {
                "answer_id": 24054,
                "answer_text": "Sahara",
                "is_correct": 0
            },
            {
                "answer_id": 24055,
                "answer_text": "Gobi",
                "is_correct": 0
            },
            {
                "answer_id": 24056,
                "answer_text": "Kalahari",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5715,
        "question_text": "In quale anno è caduto il Muro di Berlino?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 24061,
                "answer_text": "1989",
                "is_correct": 1
            },
            {
                "answer_id": 24062,
                "answer_text": "1991",
                "is_correct": 0
            },
            {
                "answer_id": 24063,
                "answer_text": "1975",
                "is_correct": 0
            },
            {
                "answer_id": 24064,
                "answer_text": "1969",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5723,
        "question_text": "Quale gas è il più abbondante nell'atmosfera terrestre?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 24093,
                "answer_text": "Azoto",
                "is_correct": 1
            },
            {
                "answer_id": 24094,
                "answer_text": "Ossigeno",
                "is_correct": 0
            },
            {
                "answer_id": 24095,
                "answer_text": "Anidride carbonica",
                "is_correct": 0
            },
            {
                "answer_id": 24096,
                "answer_text": "Argon",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5725,
        "question_text": "In quale anno è stato scoperto l'America?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 24101,
                "answer_text": "1492",
                "is_correct": 1
            },
            {
                "answer_id": 24102,
                "answer_text": "1776",
                "is_correct": 0
            },
            {
                "answer_id": 24103,
                "answer_text": "1519",
                "is_correct": 0
            },
            {
                "answer_id": 24104,
                "answer_text": "1607",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5729,
        "question_text": "Quale città ospita il Colosseo?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 24117,
                "answer_text": "Roma",
                "is_correct": 1
            },
            {
                "answer_id": 24118,
                "answer_text": "Atene",
                "is_correct": 0
            },
            {
                "answer_id": 24119,
                "answer_text": "Parigi",
                "is_correct": 0
            },
            {
                "answer_id": 24120,
                "answer_text": "Londra",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5730,
        "question_text": "Chi ha scoperto la teoria dell'evoluzione?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 24121,
                "answer_text": "Charles Darwin",
                "is_correct": 1
            },
            {
                "answer_id": 24122,
                "answer_text": "Gregor Mendel",
                "is_correct": 0
            },
            {
                "answer_id": 24123,
                "answer_text": "Louis Pasteur",
                "is_correct": 0
            },
            {
                "answer_id": 24124,
                "answer_text": "Aristotele",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5731,
        "question_text": "Qual è la lingua più parlata al mondo?",
        "category": "Linguistica",
        "answers": [
            {
                "answer_id": 24125,
                "answer_text": "Cinese mandarino",
                "is_correct": 1
            },
            {
                "answer_id": 24126,
                "answer_text": "Inglese",
                "is_correct": 0
            },
            {
                "answer_id": 24127,
                "answer_text": "Spagnolo",
                "is_correct": 0
            },
            {
                "answer_id": 24128,
                "answer_text": "Hindi",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5732,
        "question_text": "In quale anno è caduto il muro di Berlino?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 24129,
                "answer_text": "1989",
                "is_correct": 1
            },
            {
                "answer_id": 24130,
                "answer_text": "1991",
                "is_correct": 0
            },
            {
                "answer_id": 24131,
                "answer_text": "1985",
                "is_correct": 0
            },
            {
                "answer_id": 24132,
                "answer_text": "1993",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5736,
        "question_text": "In quale città si trova la Torre Eiffel?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 24145,
                "answer_text": "Parigi",
                "is_correct": 1
            },
            {
                "answer_id": 24146,
                "answer_text": "Berlino",
                "is_correct": 0
            },
            {
                "answer_id": 24147,
                "answer_text": "Roma",
                "is_correct": 0
            },
            {
                "answer_id": 24148,
                "answer_text": "Madrid",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5738,
        "question_text": "Quale oceano è il più profondo?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 24153,
                "answer_text": "Oceano Pacifico",
                "is_correct": 1
            },
            {
                "answer_id": 24154,
                "answer_text": "Oceano Atlantico",
                "is_correct": 0
            },
            {
                "answer_id": 24155,
                "answer_text": "Oceano Indiano",
                "is_correct": 0
            },
            {
                "answer_id": 24156,
                "answer_text": "Oceano Artico",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5739,
        "question_text": "Qual è il paese con più popolazione al mondo?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 24157,
                "answer_text": "India",
                "is_correct": 1
            },
            {
                "answer_id": 24158,
                "answer_text": "Cina",
                "is_correct": 0
            },
            {
                "answer_id": 24159,
                "answer_text": "Stati Uniti",
                "is_correct": 0
            },
            {
                "answer_id": 24160,
                "answer_text": "Brasile",
                "is_correct": 0
            }
        ]
    }
]