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
let rankedQueue = []; // Coda per il matchmaking Ranked
let rankedRooms = [];
const PING_INTERVAL = 10000; // Tempo tra un ping e l'altro (10 sec)
const PING_TIMEOUT = 15000; // Timeout per considerare il client disconnesso (15 sec)
const pendingTimeouts = new Map();

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('userLoggedIn', (userData) => {
        const userId = Number(userData.userId);
        const username = userData.username;
        if (isNaN(userId)) {
            console.error(`❌ Errore: userId non valido (${userData.userId})`);
            return;
        }

        // Controlla se l'utente esiste già
        const existingUser = users.find(u => u.userId === userId);
        if (existingUser) {
            users = users.filter(u => u.userId !== userId); // Rimuove il vecchio socket
        }

        users.push({ userId, socketId: socket.id, lastPing: Date.now(), username });

        // 🔥 Non sovrascrivere se lo stato è già "in_room"
        if (existingUser?.status !== "in_room" && existingUser?.status !== "playing") {
            const userIndex = users.findIndex(u => u.userId === userId);
            if (userIndex !== -1) {
                users[userIndex].status = 'online'; // ✅ Mantiene coerente lo stato in memoria
            } else {
                console.warn(`⚠️ [WARNING] Utente ${userId} non trovato in memoria.`);
            }
            updateFriendsStatus(userId, "online");
        }

        console.log(`✅ User ${userId} connesso con socket ${socket.id}`);
    });

    socket.on('deleteUser', async (data) => {
        const userId = Number(data.userId);
        if (isNaN(userId)) {
            socket.emit('deleteUserResponse', { success: false, message: 'Invalid userId' });
            return;
        }

        try {
            await deleteUserFromDB(userId);

            // Rimuovi l'utente dalla lista in memoria
            users = users.filter(u => u.userId !== userId);

            socket.emit('deleteUserResponse', { success: true, message: 'User deleted successfully' });
            socket.disconnect(true);
        } catch (err) {
            socket.emit('deleteUserResponse', { success: false, message: 'Error deleting user from DB' });
        }
    });

    socket.on('pong', () => {
        const user = users.find(u => u.socketId === socket.id);
        if (user) {
            user.lastPing = Date.now();
        }
    });

    setInterval(() => {
        const now = Date.now();

        users.forEach((user) => {
            if (now - user.lastPing > PING_TIMEOUT) {
                console.log(`🚫 Utente ${user.socketId} considerato disconnesso (timeout ping)`);
                user.status = 'offline'; // ✅ Mantiene coerente lo stato in memoria
                updateFriendsStatus(user.userId, 'offline')
                handleUserDisconnect(user.socketId);
            } else {
                if (user?.status !== "in_room" && user?.status !== "playing" && user?.status !== "online") {

                    user.status = 'online'; // ✅ Mantiene coerente lo stato in memoria
                    updateFriendsStatus(user.userId, "online");
                }
                io.to(user.socketId).emit('ping'); // Invia un ping al client
            }
        });
    }, PING_INTERVAL);


    socket.on('findRankedMatch', async ({ userId }) => {
        try {
            updateFriendsStatus(userId, "in_room");
            const userRankQuery = await pool.query(`SELECT rank FROM users WHERE id = $1`, [userId]);
            if (userRankQuery.rowCount === 0) return;

            const userRank = userRankQuery.rows[0].rank;
            console.log(`🔍 [Ranked] Utente ${userId} (Rank ${userRank}) cerca un avversario...`);
            const user = users.find(x => x.userId === userId);
            console.log(user)
            // ✅ Aggiungiamo il giocatore alla coda
            rankedQueue.push({ userId, rank: userRank, username: user.username });

            // ✅ Proviamo subito a trovare un match
            tryMatch();

            // ✅ Dopo 10 secondi allarghiamo il range di ricerca
            const expandTimeout = setTimeout(() => {
                const player = rankedQueue.find(p => p.userId === userId);
                if (player) {
                    console.log(`🔄 [Ranked] Espandiamo la ricerca per ${userId}...`);
                    player.rank -= 200;
                    player.rank += 200;
                    tryMatch();
                }
            }, 10000);

            // ✅ Dopo 25 secondi, se non trova nessuno, crea un bot
            const botTimeout = setTimeout(() => {
                const index = rankedQueue.findIndex(p => p.userId === userId);
                if (index !== -1) {
                    console.log(`🤖 [BOT] Creiamo un avversario per ${userId} dopo 25 secondi`);
                    rankedQueue.splice(index, 1);

                    const botId = `bot_${Date.now()}`;
                    const botName = getRandomBotName();
                    const botRank = userRank + (Math.random() * 100 - 50);
                    const roomId = `ranked_${Date.now()}`;

                    rankedRooms.push({
                        id: roomId,
                        players: [
                            { playerId: userId, rank: userRank, isBot: false, username: rankedQueue.username },
                            { playerId: botId, rank: botRank, isBot: true, botName: botName }
                        ],
                        status: 'playing'
                    });

                    console.log(`🏆 [Ranked] Stanza creata: ${roomId} tra ${userId} e BOT ${botName}`);

                    io.to(users.find(u => u.userId === userId)?.socketId).emit('rankedMatchFound', {
                        roomId,
                        players: [{ playerId: userId, rank: userRank, username: rankedQueue.username }, { playerId: botId, rank: botRank, botName }],
                        settings: { questionCount: 10, timePerQuestion: 15, category: "Random" }
                    });
            updateFriendsStatus(userId, "playing");

                }
            }, 25000);

            // ✅ Salviamo i timeout per poterli annullare
            pendingTimeouts.set(userId, { expandTimeout, botTimeout });

        } catch (err) {
            console.error('❌ Errore nel matchmaking ranked:', err);
        }
    });

    socket.on('saveRankedResult', async ({ roomId, userId, correctAnswers, totalTime }) => {
        console.log(`📥 [SERVER] Salvataggio risultato Ranked - User ${userId} Room ${roomId}`);

        const room = rankedRooms.find(r => r.id === roomId);
        if (!room) {
            io.to(socket.id).emit('error', 'Room not found');
            return;
        }

        if (!room.results) room.results = [];

        // Salva risultato solo se non già presente
        if (!room.results.find(r => r.userId === userId)) {
            room.results.push({ userId, correctAnswers, totalTime });

            try {
                await pool.query(`
              INSERT INTO ranked_results (room_id, user_id, correct_answers, total_time)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT (room_id, user_id) DO UPDATE
              SET correct_answers = EXCLUDED.correct_answers,
                  total_time = EXCLUDED.total_time;
            `, [roomId, userId, correctAnswers, totalTime]);

                console.log(`✅ Risultato salvato per ${userId}`);
            } catch (err) {
                console.error('❌ Errore nel salvataggio DB:', err);
            }
        }

        // Se c'è un bot, generiamo il suo risultato se manca
        const bot = room.players.find(p => p.isBot);
        if (bot && !room.results.find(r => r.userId === bot.playerId)) {
            const botResult = {
                userId: bot.playerId,
                correctAnswers: Math.floor(Math.random() * 10),
                totalTime: totalTime + Math.floor(Math.random() * 5)
            };
            room.results.push(botResult);

            // try {
            //     await pool.query(`
            //   INSERT INTO ranked_results (room_id, user_id, correct_answers, total_time)
            //   VALUES ($1, $2, $3, $4)
            // `, [roomId, botResult.userId, botResult.correctAnswers, botResult.totalTime]);

            //     console.log(`🤖 Risultato BOT ${bot.playerId} salvato`);
            // } catch (err) {
            //     console.error('❌ Errore nel salvataggio BOT:', err);
            // }
        }

        // Se entrambi hanno terminato
        if (room.results.length === room.players.length) {
            console.log(`🏁 Tutti i giocatori nella stanza ${roomId} hanno terminato.`);

            const [r1, r2] = room.results;
            const p1 = room.players.find(p => p.playerId === r1.userId);
            const p2 = room.players.find(p => p.playerId === r2.userId);

            const winner =
                r1.correctAnswers > r2.correctAnswers ? r1 :
                    r1.correctAnswers < r2.correctAnswers ? r2 :
                        r1.totalTime < r2.totalTime ? r1 : r2;

            const loser = winner.userId === r1.userId ? r2 : r1;
            const winnerId = winner.userId;
            const loserId = loser.userId;

            // 🔥 Aggiorna il rank solo se NON è un bot
            if (!String(winnerId).startsWith("bot_")) {
                await pool.query(`UPDATE users SET rank = rank + 100 WHERE id = $1`, [winnerId]);
            }

            if (!String(loserId).startsWith("bot_")) {
                await pool.query(`UPDATE users SET rank = rank - 50 WHERE id = $1`, [loserId]);
            }

            // 📤 Invia risultati ai soli giocatori reali

            room.players.forEach(async player => {
                const isBot = String(player.playerId).startsWith("bot_");
                if (isBot) return;
                const { rows } = await pool.query(`SELECT rank FROM users WHERE id = $1`, [player.playerId]);
                const updatedPoints = rows[0]?.rank ?? 0;
                const isWinner = player.playerId === winnerId;
                const user = users.find(u => u.userId === player.playerId);
                const pointsChange = isWinner ? 100 : -50;

                io.to(user?.socketId).emit('rankedMatchResult', {
                    result: isWinner ? 'win' : 'lose',
                    correctAnswers: isWinner ? winner.correctAnswers : loser.correctAnswers,
                    totalTime: isWinner ? winner.totalTime : loser.totalTime,
                    pointsChange,
                    points: updatedPoints // 🔥 AGGIUNTO
                });

                if (user) {
                    user.status = "online";
                    updateFriendsStatus(player.playerId, "online");
                }
            });

            // 🧹 Cleanup stanza
            setTimeout(() => {
                rankedRooms = rankedRooms.filter(r => r.id !== roomId);
                console.log(`🗑️ Stanza ${roomId} rimossa`);
            }, 10000);
        }
    });

    socket.on('createRoom', ({ userId, userName }) => {
        const roomId = `room_${Date.now()}`;

        const newRoom = {
            id: roomId,
            name: roomId,  // ✅ Nome iniziale uguale all'ID
            players: [{ playerId: userId, playerName: userName, isCreator: true }],
            status: 'waiting'
        };

        rooms.push(newRoom);
        const userIndex = users.findIndex(u => u.userId === userId);
        if (userIndex !== -1) {
            users[userIndex].status = 'in_room'; // ✅ Mantiene coerente lo stato in memoria
        } else {
            console.warn(`⚠️ [WARNING] Utente ${userId} non trovato in memoria.`);
        }
        updateFriendsStatus(userId, "in_room");

        io.to(socket.id).emit('roomCreated', newRoom);
    });

    socket.on('joinRoom', ({ userId, userName, roomId }) => {
        const room = rooms.find(r => r.id === roomId);
        if (room && room.players.length < 5 || room?.players.find(x => x.playerId === userId)) {
            if (!room?.players.find(x => x.playerId === userId)) {
                room.players.push({ playerId: userId, playerName: userName, isCreator: false });
                room.players.forEach(player => io.to(users.find(u => u.userId === player.playerId)?.socketId).emit('roomUpdated', room));
                room.players.forEach(player => {
                    // 🔍 Trova l'utente nella lista `users`
                    const user = users.find(u => u.userId === player.playerId);

                    if (user) {
                        user.status = "in_room"; // ✅ Aggiorna lo stato nella memoria del server
                        console.log(`🟠 [DEBUG] Stato aggiornato: ${player.playerId} → playing`);
                    } else {
                        console.warn(`⚠️ [WARNING] Utente ${player.playerId} non trovato in memoria.`);
                    }

                    updateFriendsStatus(player.playerId, "in_room");
                });

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
                `SELECT id, username, rank FROM users WHERE id = $1`,
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
                io.to(receiver.socketId).emit('newFriendRequest', { receiverId });
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

            console.log(`✅ [SERVER] Amicizia confermata tra ${senderId} e ${receiverId}`);

            // Troviamo entrambi gli utenti nella lista degli utenti connessi
            const sender = users.find(u => u.userId === senderId);
            const receiver = users.find(u => u.userId === receiverId);

            // 🔄 Aggiorniamo la lista amici per entrambi gli utenti
            const updateFriendsList = async (userId, socketId) => {
                if (socketId) {
                    const friends = await pool.query(
                        `SELECT u.id, u.username 
                         FROM friends 
                         JOIN users u ON (
                             (friends.user_id1 = u.id AND friends.user_id2 = $1) 
                             OR 
                             (friends.user_id2 = u.id AND friends.user_id1 = $1)
                         )`,
                        [userId]
                    );
                    io.to(socketId).emit('friendsList', friends.rows);
                }
            };

            // 🔄 Aggiorna la lista amici per entrambi
            if (sender) updateFriendsList(senderId, sender.socketId);
            if (receiver) updateFriendsList(receiverId, receiver.socketId);

        } catch (err) {
            console.error('❌ Errore nell\'accettare la richiesta:', err);
        }
    });


    socket.on('getFriendsList', async ({ userId }) => {
        try {
            const friends = await pool.query(
                `SELECT u.id, u.username, 
                    COALESCE(us.status, 'offline') AS status
                 FROM friends 
                 JOIN users u ON (
                     (friends.user_id1 = u.id AND friends.user_id2 = $1) 
                     OR 
                     (friends.user_id2 = u.id AND friends.user_id1 = $1)
                 )
                 LEFT JOIN (
                    SELECT id, status FROM users
                 ) us ON u.id = us.id`, // 🔥 CORRETTO: us.id invece di us.userId
                [userId]
            );

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

            room.players.forEach(player => {
                // 🔍 Trova l'utente nella lista `users`
                const user = users.find(u => u.userId === player.playerId);

                if (user) {
                    user.status = "online"; // ✅ Aggiorna lo stato nella memoria del server
                    console.log(`🟠 [DEBUG] Stato aggiornato: ${player.playerId} → playing`);
                } else {
                    console.warn(`⚠️ [WARNING] Utente ${player.playerId} non trovato in memoria.`);
                }

                // 🔄 Aggiorna il database e notifica gli amici
                updateFriendsStatus(player.playerId, "online");
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

    socket.on('inviteToRoom', ({ senderId, senderName, receiverId, roomId }) => {
        const receiver = users.find(u => u.userId === receiverId);

        if (receiver) {
            // Se l'utente è online, invia l'invito
            io.to(receiver.socketId).emit('roomInvitation', { senderId, senderName, roomId });
            console.log(`📩 Invito inviato a ${receiverId} per la stanza ${roomId}`);
        } else {
            console.log(`❌ Utente ${receiverId} non online. Salvo invito nel DB.`);
            // Se l'utente è offline, salviamo l'invito nel database per notificarglielo dopo
            pool.query(
                `INSERT INTO invitations (sender_id, receiver_id, room_id, status) VALUES ($1, $2, $3, 'pending')`,
                [senderId, receiverId, roomId]
            );
        }
    });


    socket.on('exit', ({ userId, id }) => {
        rooms.forEach(room => {
            if (room.id === id) {
                room.players = room.players.filter(player => player.playerId !== userId);
                if (room.players.length === 0) {
                    rooms = rooms.filter(r => r.id !== room.id)
                    io.emit('roomsData', rooms);

                } else {
                    room.players.forEach(p => io.to(users.find(u => u.userId === p.playerId)?.socketId).emit('roomUpdated', room))
                };
            }
        });
        const userIndex = users.findIndex(u => u.userId === userId);
        if (userIndex !== -1) {
            users[userIndex].status = 'online'; // ✅ Mantiene coerente lo stato in memoria
        } else {
            console.warn(`⚠️ [WARNING] Utente ${userId} non trovato in memoria.`);
        }
        updateFriendsStatus(userId, "online");
    });

    socket.on('findOpponent', (userId) => {
        console.log(`Finding opponent for ${userId}`);
        // Logica per trovare un avversario
        io.emit('opponentFound', { userId, opponent: 'opponent data' });
    });

    socket.on('getRooms', () => {
        io.to(socket.id).emit('roomsData', rooms);
    });

    socket.on('updateRoom', (settings) => {
        const { roomId, newSettings } = settings;
        const room = rooms.find(r => r.id === roomId);

        if (room) {
            if (newSettings.name && room.players.find(p => p.playerId === newSettings.userId)?.isCreator) {
                room.name = newSettings.name;
            }
            Object.assign(room, newSettings);

            room.players.forEach(p => {
                const socket = users.find(u => u.userId === p.playerId)?.socketId
                if (socket) {
                    io.to(socket).emit('roomUpdated', room);
                }
            });
            io.emit('roomsData', rooms);

            if (newSettings.status === 'started') {
                console.log(`🎮 [DEBUG] La partita nella stanza ${roomId} è iniziata! Aggiornamento stato utenti...`);

                room.players.forEach(player => {
                    // 🔍 Trova l'utente nella lista `users`
                    const user = users.find(u => u.userId === player.playerId);

                    if (user) {
                        user.status = "playing"; // ✅ Aggiorna lo stato nella memoria del server
                        console.log(`🟠 [DEBUG] Stato aggiornato: ${player.playerId} → playing`);
                    } else {
                        console.warn(`⚠️ [WARNING] Utente ${player.playerId} non trovato in memoria.`);
                    }

                    // 🔄 Aggiorna il database e notifica gli amici
                    updateFriendsStatus(player.playerId, "playing");
                });
            }


        } else {
            console.log(`Room with ID ${roomId} not found.`);
        }
    });

    socket.on('deleteRoom', ({ id }) => {
        const room = rooms.find(r => r.id === id);
        if (!room) {
            console.warn(`⚠️ [WARNING] Stanza ${id} non trovata.`);
            return;
        }

        console.log(`❌ [SERVER] Stanza ${id} eliminata! Notificando i giocatori...`);

        // 🔍 Notifica tutti i giocatori che la stanza è stata eliminata
        room.players.forEach(player => {
            const user = users.find(u => u.userId === player.playerId);

            if (user) {
                user.status = "online"; // ✅ Aggiorna lo stato in memoria
                io.to(user.socketId).emit('roomDeleted', { roomId: id, message: "La stanza è stata eliminata dal creatore." });
                console.log(`🔔 [DEBUG] Notifica inviata a ${player.playerId} (roomDeleted)`);
            }

            // 🔄 Aggiorna il database con lo stato "online"
            updateFriendsStatus(player.playerId, "online");
        });

        // 🔥 Rimuove la stanza dalla lista
        rooms = rooms.filter(r => r.id !== id);

        // 📢 Notifica a tutti che la lista delle stanze è aggiornata
        io.emit('roomsData', rooms);
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



    socket.on('getQuestionsRanked', ({ roomId, totalQuestions, category }) => {
        const room = rankedRooms.find(r => r.id === roomId);

        if (!room) {
            console.log(rankedRooms)
            console.log(roomId)
            io.to(socket.id).emit('roomNotFound', 'La stanza non esiste.');
            return;
        }

        console.log(`📥 [SERVER] Richiesta domande per Ranked: Stanza ${roomId}, Categoria: ${category}`);

        // Se la stanza non ha già domande assegnate, le assegniamo ora
        if (!room.questions) {
            const allQuestions = category === 'Tutte le categorie' || category === 'Random' ? questionsMock : questionsMock.filter(q => q.category === category) || questionsMock;
            const shuffled = allQuestions.sort(() => 0.5 - Math.random());
            room.questions = shuffled.slice(0, totalQuestions);
        }

        // 🔥 Invia lo stesso set di domande a tutti i giocatori della stanza
        room.players.forEach(player => {
            const playerSocket = users.find(u => u.userId === player.playerId)?.socketId;
            if (playerSocket) {
                io.to(playerSocket).emit('questionsDataRanked', { questions: room.questions });
                console.log(`📜 [SERVER] Domande inviate a ${player.playerId}`);
            }
        });
    });

    socket.on('disconnect', async () => {
        const user = users.find(u => u.socketId === socket.id);
        const userId = user?.userId;
        if (!userId) return;
        
        if (userId) {
            const userIndex = users.findIndex(u => u.userId === userId);
            if (userIndex !== -1) {
                users[userIndex].status = 'offline'; // ✅ Mantiene coerente lo stato in memoria
            } else {
                console.warn(`⚠️ [WARNING] Utente ${userId} non trovato in memoria.`);
            }
            updateFriendsStatus(userId, "offline");
            users = users.filter(u => u.userId !== userId);
        }
        rooms.forEach(room => {
            room.players = room.players.filter(player => player.playerId !== userId);
            if (room.players.length === 0) rooms = rooms.filter(r => r.id !== room.id);
            else room.players.forEach(p => io.to(users.find(u => u.userId === p.playerId)?.socketId).emit('roomUpdated', room));
        });


        rankedQueue = rankedQueue.filter(p => p.userId !== userId);

        // 🎮 3. Controlla se era in una partita attiva
        const room = rankedRooms.find(room =>
          room.players.some(p => p.playerId === userId)
        );
      
        if (room) {
          console.log(`⚠️ Utente ${userId} disconnesso durante la partita nella stanza ${room.id}`);
      
          // Trova l'avversario
          const opponent = room.players.find(p => p.playerId !== userId);
          const opponentUser = users.find(u => u.userId === opponent?.playerId);
      
          if (opponent && opponentUser) {
            // 💥 Diamo la vittoria all'avversario (solo se non è un bot)
            const winnerId = opponent.playerId;
            const loserId = userId;
      
            if (!String(winnerId).startsWith("bot_")) {
              await pool.query(`UPDATE users SET rank = rank + 100 WHERE id = $1`, [winnerId]);
            }
            if (!String(loserId).startsWith("bot_")) {
              await pool.query(`UPDATE users SET rank = rank - 50 WHERE id = $1`, [loserId]);
            }
      
            io.to(opponentUser.socketId).emit('rankedMatchResult', {
              result: 'win',
              correctAnswers: 0,
              totalTime: 0,
              pointsChange: 100,
              points: (await getUserRank(winnerId)) // funzione helper per ottenere rank aggiornato
            });
      
            opponentUser.status = 'online';
            updateFriendsStatus(winnerId, 'online');
            updateFriendsStatus(userId, "offline");

          }
      
          // 🧹 Rimuovi la stanza
          clearTimeout(pendingTimeouts.get(userId)?.expandTimeout);
clearTimeout(pendingTimeouts.get(userId)?.botTimeout);
pendingTimeouts.delete(userId);

          rankedRooms = rankedRooms.filter(r => r.id !== room.id);
          console.log(`🗑️ Stanza ${room.id} rimossa causa disconnessione`);
        }

    });
    socket.on('leaveQueue', ({ userId }) => {
        console.log(`👋 [SERVER] Utente ${userId} ha lasciato la coda.`);
    
        rankedQueue = rankedQueue.filter(player => player.userId !== userId);
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

async function getUserRank(userId) {
    const { rows } = await pool.query(`SELECT rank FROM users WHERE id = $1`, [userId]);
    return rows[0]?.rank ?? 0;
  }

function sendPushNotification(subscription, title, body) {
    webpush.sendNotification(subscription, JSON.stringify({ title, body }))
        .then(() => console.log('Notifica inviata!'))
        .catch(err => console.error('Errore:', err));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));


function handleUserDisconnect(socketId) {
    const user = users.find(u => u.socketId === socketId);
    if (!user) return;

    console.log(`❌ [SERVER] Disconnessione forzata dell'utente ${user.userId}`);

    // Rimuoviamo l'utente dalla lista
    users = users.filter(u => u.socketId !== user.socketId);
    // Troviamo la stanza in cui era l'utente
    const room = rooms.find(r => r.players.some(p => p.playerId === user.userId));

    if (room) {
        console.log(`🚪 Rimuoviamo ${user.userId} dalla stanza ${room.id}`);

        // Rimuoviamo il giocatore dalla stanza
        room.players = room.players.filter(p => p.playerId !== user.userId);

        // Se il giocatore non ha inviato il risultato, lo marchiamo come "Assente"
        const existingResult = room.results?.find(result => result.userId === user.userId);
        if (!existingResult) {
            room.results?.push({
                userId: user.userId,
                firstname: "Assente",
                correctAnswersCount: 0,
                totalTime: 9999 // Un valore alto indica che non ha completato
            });
        }

        // **Notifica tutti i giocatori rimasti**
        room.players.forEach(player => {
            const playerSocket = users.find(u => u.userId === player.playerId)?.socketId;
            if (playerSocket) {
                io.to(playerSocket).emit('roomUpdated', room);
                io.to(playerSocket).emit('gameResultsUpdated', room.results);
            }
        });

        // Se tutti i giocatori hanno finito, chiudiamo la stanza
        if (room.results?.length === room.players.length) {
            console.log(`🛑 Tutti i giocatori della stanza ${room.id} hanno terminato.`);

            room.players.forEach(player => {
                const playerSocket = users.find(u => u.userId === player.playerId)?.socketId;
                if (playerSocket) {
                    io.to(playerSocket).emit('gameFinished', room.results);
                }
            });
            setTimeout(() => {
                rooms = rooms.filter(r => r.id !== room.id);
                console.log(`Stanza ${room.id} rimossa dopo la conclusione.`);
            }, 10000); // Rimuove la stanza dopo 10 secondi
            // **Eliminare la stanza dopo 10 secondi**
            setTimeout(() => {
                rooms = rooms.filter(r => r.id !== room.id);
                console.log(`🗑 Stanza ${room.id} rimossa dopo la conclusione.`);
            }, 10000);
        }
    }
}

function tryMatch() {
    console.log(`🔄 [Ranked] Controllo della coda per match disponibili...`);

    for (let i = 0; i < rankedQueue.length; i++) {
        for (let j = i + 1; j < rankedQueue.length; j++) {
            const player1 = rankedQueue[i];
            const player2 = rankedQueue[j];

            // 🔒 Previeni match con se stessi
            if (player1.userId === player2.userId) continue;

            if (Math.abs(player1.rank - player2.rank) <= 200) {
                const roomId = `ranked_${Date.now()}`;

                console.log(`✅ [Ranked] Match trovato: ${player1.userId} vs ${player2.userId}`);
                console.log(`🏆 Creiamo la stanza: ${roomId}`);

                rankedRooms.push({
                    id: roomId,
                    players: [
                        { playerId: player1.userId, rank: player1.rank, isBot: false, username: player1.username },
                        { playerId: player2.userId, rank: player2.rank, isBot: false, username: player2.username }
                    ],
                    status: 'playing'
                });

                const socket1 = users.find(u => u.userId === player1.userId)?.socketId;
                const socket2 = users.find(u => u.userId === player2.userId)?.socketId;

                io.to(socket1).emit('rankedMatchFound', {
                    roomId,
                    players: [
                        { playerId: player1.userId, rank: player1.rank, username: player1.username },
                        { playerId: player2.userId, rank: player2.rank, username: player2.username }
                    ],
                    settings: { questionCount: 10, timePerQuestion: 15, category: "Random" }
                });

                io.to(socket2).emit('rankedMatchFound', {
                    roomId,
                    players: [
                        { playerId: player1.userId, rank: player1.rank, username: player1.username },
                        { playerId: player2.userId, rank: player2.rank, username: player2.username }
                    ],
                    settings: { questionCount: 10, timePerQuestion: 15, category: "Random" }
                });

                // ✅ Aggiorna stato amici per entrambi i player
                updateFriendsStatus(player1.userId, "playing");
                updateFriendsStatus(player2.userId, "playing");

                // ✅ Rimuoviamo i due giocatori dalla coda
                rankedQueue = rankedQueue.filter(p =>
                    p.userId !== player1.userId && p.userId !== player2.userId
                );

                // ✅ Annulliamo i timeout
                [player1.userId, player2.userId].forEach(uid => {
                    clearTimeout(pendingTimeouts.get(uid)?.expandTimeout);
                    clearTimeout(pendingTimeouts.get(uid)?.botTimeout);
                    pendingTimeouts.delete(uid);
                });

                // ✅ Ricontrolliamo la coda in caso ci siano altri match disponibili
                tryMatch();

                return;
            }
        }
    }
}

const deleteUserFromDB = async (userId) => {
    // Esempio con PostgreSQL (adatta al tuo DB)
    try {
        await db.query('DELETE FROM users WHERE id = $1', [userId]);
        await db.query('DELETE FROM friends WHERE user_id1 = $1 OR user_id2 = $1', [userId]);
        await db.query('DELETE FROM ranked_results WHERE user_id = $1', [userId]);
        await db.query('DELETE FROM game_results WHERE user_id = $1', [userId]);
        console.log(`✅ Utente ${userId} eliminato dal database`);
    } catch (err) {
        console.error(`❌ Errore durante l'eliminazione dal DB per utente ${userId}:`, err);
        throw err;
    }
};  


async function updateFriendsStatus(userId, status) {
    console.log(`🔄 [DEBUG] Cambiando stato di ${userId} → ${status} (chiamato da: ${getCallerFunction()})`);

    try {
        await pool.query(`UPDATE users SET status = $1 WHERE id = $2`, [status, userId]);

        // Notifica gli amici dell'aggiornamento di stato
        const friends = await pool.query(
            `SELECT u.id FROM friends 
             JOIN users u ON (
                 (friends.user_id1 = u.id AND friends.user_id2 = $1) 
                 OR 
                 (friends.user_id2 = u.id AND friends.user_id1 = $1)
             )`,
            [userId]
        );

        friends.rows.forEach(friend => {
            const friendSocket = users.find(u => u.userId === friend.id)?.socketId;
            if (friendSocket) {
                io.to(friendSocket).emit('friendStatusUpdate', { userId, status });
            }
        });

    } catch (err) {
        console.error('❌ Errore nell\'aggiornare lo stato agli amici:', err);
    }
}

// 🔍 Funzione per trovare chi sta chiamando updateFriendsStatus()
function getCallerFunction() {
    try {
        const err = new Error();
        const stackLines = err.stack.split("\n");
        return stackLines[3].trim(); // Mostra la funzione che chiama updateFriendsStatus()
    } catch {
        return "Unknown";
    }
}


function getRandomBotName() {
    const botNames = ["AI_Monster", "TriviaMaster3000", "Botinator", "QuizBot", "CyberBrain", "NeoQuiz"];
    return botNames[Math.floor(Math.random() * botNames.length)];
}


const questionsMock = [
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
        "id": 4889,
        "question_text": "In che anno è iniziata la Seconda Guerra Mondiale?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 19652,
                "answer_text": "1939",
                "is_correct": 1
            },
            {
                "answer_id": 19653,
                "answer_text": "1945",
                "is_correct": 0
            },
            {
                "answer_id": 19654,
                "answer_text": "1914",
                "is_correct": 0
            },
            {
                "answer_id": 19655,
                "answer_text": "1929",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5251,
        "question_text": "Qual è la capitale del Giappone?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21504,
                "answer_text": "Tokyo",
                "is_correct": 1
            },
            {
                "answer_id": 21505,
                "answer_text": "Lima",
                "is_correct": 0
            },
            {
                "answer_id": 21506,
                "answer_text": "Caracas",
                "is_correct": 0
            },
            {
                "answer_id": 21507,
                "answer_text": "Santiago",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25075,
        "question_text": "Chi ha scritto 'La Divina Commedia'?",
        "category": "Cultura Generale",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45303,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 45300,
                "answer_text": "Dante Alighieri",
                "is_correct": 1
            },
            {
                "answer_id": 45301,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 45302,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4892,
        "question_text": "Qual è il risultato di 8 x 7?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 19664,
                "answer_text": "56",
                "is_correct": 1
            },
            {
                "answer_id": 19665,
                "answer_text": "49",
                "is_correct": 0
            },
            {
                "answer_id": 19666,
                "answer_text": "64",
                "is_correct": 0
            },
            {
                "answer_id": 19667,
                "answer_text": "54",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 8335,
        "question_text": "Qual è la capitale della Francia?",
        "category": "Cultura Generale",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 33040,
                "answer_text": "Parigi",
                "is_correct": 1
            },
            {
                "answer_id": 33042,
                "answer_text": "Lione",
                "is_correct": 0
            },
            {
                "answer_id": 33041,
                "answer_text": "Marsiglia",
                "is_correct": 0
            },
            {
                "answer_id": 33043,
                "answer_text": "Nizza",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4894,
        "question_text": "Chi ha scritto 'Romeo e Giulietta'?",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 19672,
                "answer_text": "William Shakespeare",
                "is_correct": 1
            },
            {
                "answer_id": 19673,
                "answer_text": "Charles Dickens",
                "is_correct": 0
            },
            {
                "answer_id": 19674,
                "answer_text": "Jane Austen",
                "is_correct": 0
            },
            {
                "answer_id": 19675,
                "answer_text": "Victor Hugo",
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
        "id": 4896,
        "question_text": "In che continente si trova il Brasile?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 19680,
                "answer_text": "Sud America",
                "is_correct": 1
            },
            {
                "answer_id": 19681,
                "answer_text": "Europa",
                "is_correct": 0
            },
            {
                "answer_id": 19682,
                "answer_text": "Asia",
                "is_correct": 0
            },
            {
                "answer_id": 19683,
                "answer_text": "Africa",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5883,
        "question_text": "Chi ha dipinto la Gioconda?",
        "category": "Arte",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 23233,
                "answer_text": "18375573",
                "is_correct": 0
            },
            {
                "answer_id": 23232,
                "answer_text": "Leonardo da Vinci",
                "is_correct": 1
            },
            {
                "answer_id": 23235,
                "answer_text": "577f9745",
                "is_correct": 0
            },
            {
                "answer_id": 23234,
                "answer_text": "f4cd0192",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5031,
        "question_text": "Chi ha scoperto la penicillina?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20224,
                "answer_text": "Alexander Fleming",
                "is_correct": 1
            },
            {
                "answer_id": 20225,
                "answer_text": "Pasteur",
                "is_correct": 0
            },
            {
                "answer_id": 20226,
                "answer_text": "Curie",
                "is_correct": 0
            },
            {
                "answer_id": 20227,
                "answer_text": "Newton",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4901,
        "question_text": "Qual è la capitale della Germania?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 19704,
                "answer_text": "Berlino",
                "is_correct": 1
            },
            {
                "answer_id": 19705,
                "answer_text": "Monaco",
                "is_correct": 0
            },
            {
                "answer_id": 19706,
                "answer_text": "Amburgo",
                "is_correct": 0
            },
            {
                "answer_id": 19707,
                "answer_text": "Francoforte",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25085,
        "question_text": "Chi ha scritto 'Il nome della rosa'?",
        "category": "Cultura Generale",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45341,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 45342,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 45343,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 45340,
                "answer_text": "Umberto Eco",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5828,
        "question_text": "Quanto fa 9 x 6?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 22812,
                "answer_text": "54",
                "is_correct": 1
            },
            {
                "answer_id": 22814,
                "answer_text": "90",
                "is_correct": 0
            },
            {
                "answer_id": 22813,
                "answer_text": "98",
                "is_correct": 0
            },
            {
                "answer_id": 22815,
                "answer_text": "101",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4904,
        "question_text": "In quale anno l’uomo ha messo piede sulla Luna?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 19716,
                "answer_text": "1969",
                "is_correct": 1
            },
            {
                "answer_id": 19717,
                "answer_text": "1972",
                "is_correct": 0
            },
            {
                "answer_id": 19718,
                "answer_text": "1965",
                "is_correct": 0
            },
            {
                "answer_id": 19719,
                "answer_text": "1959",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4905,
        "question_text": "Quale gas respiriamo per vivere?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 19720,
                "answer_text": "Ossigeno",
                "is_correct": 1
            },
            {
                "answer_id": 19721,
                "answer_text": "Azoto",
                "is_correct": 0
            },
            {
                "answer_id": 19722,
                "answer_text": "Anidride carbonica",
                "is_correct": 0
            },
            {
                "answer_id": 19723,
                "answer_text": "Idrogeno",
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
        "id": 25076,
        "question_text": "Chi ha scritto 'I Promessi Sposi'?",
        "category": "Cultura Generale",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45304,
                "answer_text": "Alessandro Manzoni",
                "is_correct": 1
            },
            {
                "answer_id": 45305,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 45306,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 45307,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4908,
        "question_text": "Qual è il numero di pianeti nel Sistema Solare?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 19732,
                "answer_text": "8",
                "is_correct": 1
            },
            {
                "answer_id": 19733,
                "answer_text": "9",
                "is_correct": 0
            },
            {
                "answer_id": 19734,
                "answer_text": "7",
                "is_correct": 0
            },
            {
                "answer_id": 19735,
                "answer_text": "10",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4909,
        "question_text": "Chi ha fondato l’Impero Romano?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 19736,
                "answer_text": "Ottaviano Augusto",
                "is_correct": 1
            },
            {
                "answer_id": 19737,
                "answer_text": "Romolo",
                "is_correct": 0
            },
            {
                "answer_id": 19738,
                "answer_text": "Giulio Cesare",
                "is_correct": 0
            },
            {
                "answer_id": 19739,
                "answer_text": "Nerone",
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
        "id": 6167,
        "question_text": "Chi ha inventato la lampadina?",
        "category": "Cultura Generale",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 24371,
                "answer_text": "Alexander Graham Bell",
                "is_correct": 0
            },
            {
                "answer_id": 24370,
                "answer_text": "Guglielmo Marconi",
                "is_correct": 0
            },
            {
                "answer_id": 24368,
                "answer_text": "Thomas Edison",
                "is_correct": 1
            },
            {
                "answer_id": 24369,
                "answer_text": "Nikola Tesla",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4945,
        "question_text": "Qual è l’organo principale della respirazione?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 19880,
                "answer_text": "Polmoni",
                "is_correct": 1
            },
            {
                "answer_id": 19881,
                "answer_text": "Cuore",
                "is_correct": 0
            },
            {
                "answer_id": 19882,
                "answer_text": "Cervello",
                "is_correct": 0
            },
            {
                "answer_id": 19883,
                "answer_text": "Fegato",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4946,
        "question_text": "Chi è stato il primo presidente degli Stati Uniti?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 19884,
                "answer_text": "George Washington",
                "is_correct": 1
            },
            {
                "answer_id": 19885,
                "answer_text": "Abraham Lincoln",
                "is_correct": 0
            },
            {
                "answer_id": 19886,
                "answer_text": "Thomas Jefferson",
                "is_correct": 0
            },
            {
                "answer_id": 19887,
                "answer_text": "John Adams",
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
        "id": 4948,
        "question_text": "In quale paese si trova il Taj Mahal?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 19892,
                "answer_text": "India",
                "is_correct": 1
            },
            {
                "answer_id": 19893,
                "answer_text": "Pakistan",
                "is_correct": 0
            },
            {
                "answer_id": 19894,
                "answer_text": "Nepal",
                "is_correct": 0
            },
            {
                "answer_id": 19895,
                "answer_text": "Bangladesh",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4949,
        "question_text": "Qual è l’unità di misura della corrente elettrica?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 19896,
                "answer_text": "Ampere",
                "is_correct": 1
            },
            {
                "answer_id": 19897,
                "answer_text": "Volt",
                "is_correct": 0
            },
            {
                "answer_id": 19898,
                "answer_text": "Ohm",
                "is_correct": 0
            },
            {
                "answer_id": 19899,
                "answer_text": "Watt",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25083,
        "question_text": "Chi ha scritto 'Il piccolo principe'?",
        "category": "Cultura Generale",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45332,
                "answer_text": "Antoine de Saint-Exupéry",
                "is_correct": 1
            },
            {
                "answer_id": 45335,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 45333,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 45334,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4951,
        "question_text": "Che tipo di animale è la balena?",
        "category": "Natura",
        "answers": [
            {
                "answer_id": 19904,
                "answer_text": "Mammifero",
                "is_correct": 1
            },
            {
                "answer_id": 19905,
                "answer_text": "Pesce",
                "is_correct": 0
            },
            {
                "answer_id": 19906,
                "answer_text": "Rettili",
                "is_correct": 0
            },
            {
                "answer_id": 19907,
                "answer_text": "Anfibi",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4952,
        "question_text": "Quale scienziato ha formulato la legge di gravità?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 19908,
                "answer_text": "Isaac Newton",
                "is_correct": 1
            },
            {
                "answer_id": 19909,
                "answer_text": "Albert Einstein",
                "is_correct": 0
            },
            {
                "answer_id": 19910,
                "answer_text": "Galileo Galilei",
                "is_correct": 0
            },
            {
                "answer_id": 19911,
                "answer_text": "Stephen Hawking",
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
        "id": 4954,
        "question_text": "In che stato si trova Hollywood?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 19916,
                "answer_text": "California",
                "is_correct": 1
            },
            {
                "answer_id": 19917,
                "answer_text": "Texas",
                "is_correct": 0
            },
            {
                "answer_id": 19918,
                "answer_text": "Nevada",
                "is_correct": 0
            },
            {
                "answer_id": 19919,
                "answer_text": "Florida",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4955,
        "question_text": "Che forma ha una palla da basket?",
        "category": "Sport",
        "answers": [
            {
                "answer_id": 19920,
                "answer_text": "Sferica",
                "is_correct": 1
            },
            {
                "answer_id": 19921,
                "answer_text": "Ovale",
                "is_correct": 0
            },
            {
                "answer_id": 19922,
                "answer_text": "Cilindrica",
                "is_correct": 0
            },
            {
                "answer_id": 19923,
                "answer_text": "Cubica",
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
        "id": 4957,
        "question_text": "Quale pianeta è il più grande del sistema solare?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 19928,
                "answer_text": "Giove",
                "is_correct": 1
            },
            {
                "answer_id": 19929,
                "answer_text": "Saturno",
                "is_correct": 0
            },
            {
                "answer_id": 19930,
                "answer_text": "Urano",
                "is_correct": 0
            },
            {
                "answer_id": 19931,
                "answer_text": "Nettuno",
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
        "id": 4931,
        "question_text": "In che continente si trova l’Egitto?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 19824,
                "answer_text": "Africa",
                "is_correct": 1
            },
            {
                "answer_id": 19825,
                "answer_text": "Asia",
                "is_correct": 0
            },
            {
                "answer_id": 19826,
                "answer_text": "Europa",
                "is_correct": 0
            },
            {
                "answer_id": 19827,
                "answer_text": "America",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4932,
        "question_text": "Quale sport è associato a Michael Jordan?",
        "category": "Sport",
        "answers": [
            {
                "answer_id": 19828,
                "answer_text": "Basket",
                "is_correct": 1
            },
            {
                "answer_id": 19829,
                "answer_text": "Calcio",
                "is_correct": 0
            },
            {
                "answer_id": 19830,
                "answer_text": "Tennis",
                "is_correct": 0
            },
            {
                "answer_id": 19831,
                "answer_text": "Baseball",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4933,
        "question_text": "Quale pianeta ha gli anelli più evidenti?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 19832,
                "answer_text": "Saturno",
                "is_correct": 1
            },
            {
                "answer_id": 19833,
                "answer_text": "Giove",
                "is_correct": 0
            },
            {
                "answer_id": 19834,
                "answer_text": "Urano",
                "is_correct": 0
            },
            {
                "answer_id": 19835,
                "answer_text": "Nettuno",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25087,
        "question_text": "Chi ha scritto 'Orgoglio e pregiudizio'?",
        "category": "Cultura Generale",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45348,
                "answer_text": "Jane Austen",
                "is_correct": 1
            },
            {
                "answer_id": 45350,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 45351,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 45349,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4935,
        "question_text": "Quale città è famosa per la Statua della Libertà?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 19840,
                "answer_text": "New York",
                "is_correct": 1
            },
            {
                "answer_id": 19841,
                "answer_text": "Los Angeles",
                "is_correct": 0
            },
            {
                "answer_id": 19842,
                "answer_text": "Chicago",
                "is_correct": 0
            },
            {
                "answer_id": 19843,
                "answer_text": "Miami",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4936,
        "question_text": "Quanto fa la radice quadrata di 81?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 19844,
                "answer_text": "9",
                "is_correct": 1
            },
            {
                "answer_id": 19845,
                "answer_text": "8",
                "is_correct": 0
            },
            {
                "answer_id": 19846,
                "answer_text": "7",
                "is_correct": 0
            },
            {
                "answer_id": 19847,
                "answer_text": "6",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4937,
        "question_text": "Che animale è simbolo dell’Italia?",
        "category": "Cultura Generale",
        "answers": [
            {
                "answer_id": 19848,
                "answer_text": "Lupo",
                "is_correct": 1
            },
            {
                "answer_id": 19849,
                "answer_text": "Aquila",
                "is_correct": 0
            },
            {
                "answer_id": 19850,
                "answer_text": "Leone",
                "is_correct": 0
            },
            {
                "answer_id": 19851,
                "answer_text": "Cavallo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4938,
        "question_text": "Qual è il simbolo chimico dell’oro?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 19852,
                "answer_text": "Au",
                "is_correct": 1
            },
            {
                "answer_id": 19853,
                "answer_text": "Ag",
                "is_correct": 0
            },
            {
                "answer_id": 19854,
                "answer_text": "Fe",
                "is_correct": 0
            },
            {
                "answer_id": 19855,
                "answer_text": "O",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4939,
        "question_text": "Chi è l’autore di 'Harry Potter'?",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 19856,
                "answer_text": "J.K. Rowling",
                "is_correct": 1
            },
            {
                "answer_id": 19857,
                "answer_text": "Stephen King",
                "is_correct": 0
            },
            {
                "answer_id": 19858,
                "answer_text": "Suzanne Collins",
                "is_correct": 0
            },
            {
                "answer_id": 19859,
                "answer_text": "George R.R. Martin",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4940,
        "question_text": "In quale città si trova il Colosseo?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 19860,
                "answer_text": "Roma",
                "is_correct": 1
            },
            {
                "answer_id": 19861,
                "answer_text": "Milano",
                "is_correct": 0
            },
            {
                "answer_id": 19862,
                "answer_text": "Napoli",
                "is_correct": 0
            },
            {
                "answer_id": 19863,
                "answer_text": "Firenze",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4941,
        "question_text": "Chi ha dipinto 'L’ultima cena'?",
        "category": "Arte",
        "answers": [
            {
                "answer_id": 19864,
                "answer_text": "Leonardo da Vinci",
                "is_correct": 1
            },
            {
                "answer_id": 19865,
                "answer_text": "Raffaello",
                "is_correct": 0
            },
            {
                "answer_id": 19866,
                "answer_text": "Caravaggio",
                "is_correct": 0
            },
            {
                "answer_id": 19867,
                "answer_text": "Michelangelo",
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
        "id": 4943,
        "question_text": "Quanto fa 5 al quadrato?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 19872,
                "answer_text": "25",
                "is_correct": 1
            },
            {
                "answer_id": 19873,
                "answer_text": "20",
                "is_correct": 0
            },
            {
                "answer_id": 19874,
                "answer_text": "15",
                "is_correct": 0
            },
            {
                "answer_id": 19875,
                "answer_text": "30",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25079,
        "question_text": "Chi ha scritto 'La coscienza di Zeno'?",
        "category": "Cultura Generale",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45316,
                "answer_text": "Italo Svevo",
                "is_correct": 1
            },
            {
                "answer_id": 45317,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 45319,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 45318,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4914,
        "question_text": "In che anno è caduto il muro di Berlino?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 19756,
                "answer_text": "1989",
                "is_correct": 1
            },
            {
                "answer_id": 19757,
                "answer_text": "1991",
                "is_correct": 0
            },
            {
                "answer_id": 19758,
                "answer_text": "1985",
                "is_correct": 0
            },
            {
                "answer_id": 19759,
                "answer_text": "1993",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4915,
        "question_text": "Quale animale è noto per la sua lentezza?",
        "category": "Natura",
        "answers": [
            {
                "answer_id": 19760,
                "answer_text": "Bradipo",
                "is_correct": 1
            },
            {
                "answer_id": 19761,
                "answer_text": "Ghepardo",
                "is_correct": 0
            },
            {
                "answer_id": 19762,
                "answer_text": "Cavallo",
                "is_correct": 0
            },
            {
                "answer_id": 19763,
                "answer_text": "Canguro",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5881,
        "question_text": "Chi ha composto la Nona Sinfonia?",
        "category": "Musica",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 23227,
                "answer_text": "069133cd",
                "is_correct": 0
            },
            {
                "answer_id": 23226,
                "answer_text": "d58dabdc",
                "is_correct": 0
            },
            {
                "answer_id": 23225,
                "answer_text": "613a8b6d",
                "is_correct": 0
            },
            {
                "answer_id": 23224,
                "answer_text": "Beethoven",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 4917,
        "question_text": "Qual è l’elemento chimico con simbolo Fe?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 19768,
                "answer_text": "Ferro",
                "is_correct": 1
            },
            {
                "answer_id": 19769,
                "answer_text": "Fluoro",
                "is_correct": 0
            },
            {
                "answer_id": 19770,
                "answer_text": "Fosforo",
                "is_correct": 0
            },
            {
                "answer_id": 19771,
                "answer_text": "Francio",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5042,
        "question_text": "Chi ha inventato il telefono?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 20268,
                "answer_text": "Alexander Graham Bell",
                "is_correct": 1
            },
            {
                "answer_id": 20269,
                "answer_text": "Edison",
                "is_correct": 0
            },
            {
                "answer_id": 20270,
                "answer_text": "Tesla",
                "is_correct": 0
            },
            {
                "answer_id": 20271,
                "answer_text": "Marconi",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5895,
        "question_text": "Qual è il fiume più lungo del mondo?",
        "category": "Cultura Generale",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 23282,
                "answer_text": "16273061",
                "is_correct": 0
            },
            {
                "answer_id": 23281,
                "answer_text": "fc0e5641",
                "is_correct": 0
            },
            {
                "answer_id": 23280,
                "answer_text": "Nilo",
                "is_correct": 1
            },
            {
                "answer_id": 23283,
                "answer_text": "48f749e4",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4920,
        "question_text": "Quale pianeta è noto come il pianeta rosso?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 19780,
                "answer_text": "Marte",
                "is_correct": 1
            },
            {
                "answer_id": 19781,
                "answer_text": "Venere",
                "is_correct": 0
            },
            {
                "answer_id": 19782,
                "answer_text": "Saturno",
                "is_correct": 0
            },
            {
                "answer_id": 19783,
                "answer_text": "Giove",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4921,
        "question_text": "Quale strumento misura la temperatura?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 19784,
                "answer_text": "Termometro",
                "is_correct": 1
            },
            {
                "answer_id": 19785,
                "answer_text": "Barometro",
                "is_correct": 0
            },
            {
                "answer_id": 19786,
                "answer_text": "Igrometro",
                "is_correct": 0
            },
            {
                "answer_id": 19787,
                "answer_text": "Altimetro",
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
        "id": 4924,
        "question_text": "Qual è il colore primario tra questi?",
        "category": "Arte",
        "answers": [
            {
                "answer_id": 19796,
                "answer_text": "Rosso",
                "is_correct": 1
            },
            {
                "answer_id": 19797,
                "answer_text": "Verde",
                "is_correct": 0
            },
            {
                "answer_id": 19798,
                "answer_text": "Arancione",
                "is_correct": 0
            },
            {
                "answer_id": 19799,
                "answer_text": "Viola",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4925,
        "question_text": "Chi era il dio del mare nella mitologia greca?",
        "category": "Mitologia",
        "answers": [
            {
                "answer_id": 19800,
                "answer_text": "Poseidone",
                "is_correct": 1
            },
            {
                "answer_id": 19801,
                "answer_text": "Zeus",
                "is_correct": 0
            },
            {
                "answer_id": 19802,
                "answer_text": "Ade",
                "is_correct": 0
            },
            {
                "answer_id": 19803,
                "answer_text": "Apollo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4926,
        "question_text": "In che sport si usa una racchetta e una pallina gialla?",
        "category": "Sport",
        "answers": [
            {
                "answer_id": 19804,
                "answer_text": "Tennis",
                "is_correct": 1
            },
            {
                "answer_id": 19805,
                "answer_text": "Ping pong",
                "is_correct": 0
            },
            {
                "answer_id": 19806,
                "answer_text": "Badminton",
                "is_correct": 0
            },
            {
                "answer_id": 19807,
                "answer_text": "Golf",
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
        "id": 4928,
        "question_text": "Quanti secondi ci sono in un minuto?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 19812,
                "answer_text": "60",
                "is_correct": 1
            },
            {
                "answer_id": 19813,
                "answer_text": "100",
                "is_correct": 0
            },
            {
                "answer_id": 19814,
                "answer_text": "30",
                "is_correct": 0
            },
            {
                "answer_id": 19815,
                "answer_text": "120",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4912,
        "question_text": "Quanto fa 12 diviso 4?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 19748,
                "answer_text": "3",
                "is_correct": 1
            },
            {
                "answer_id": 19749,
                "answer_text": "2",
                "is_correct": 0
            },
            {
                "answer_id": 19750,
                "answer_text": "4",
                "is_correct": 0
            },
            {
                "answer_id": 19751,
                "answer_text": "6",
                "is_correct": 0
            }
        ]
    },
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
        "id": 25082,
        "question_text": "Chi ha scritto '1984'?",
        "category": "Cultura Generale",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45331,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 45330,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 45328,
                "answer_text": "George Orwell",
                "is_correct": 1
            },
            {
                "answer_id": 45329,
                "answer_text": "Gabriele D’Annunzio",
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
        "id": 6025,
        "question_text": "Qual è la capitale del Canada?",
        "category": "Cultura Generale",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 23803,
                "answer_text": "Montreal",
                "is_correct": 0
            },
            {
                "answer_id": 23800,
                "answer_text": "Ottawa",
                "is_correct": 1
            },
            {
                "answer_id": 23802,
                "answer_text": "Vancouver",
                "is_correct": 0
            },
            {
                "answer_id": 23801,
                "answer_text": "Toronto",
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
        "id": 6163,
        "question_text": "In quale città si trova la Cappella Sistina?",
        "category": "Arte",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 24352,
                "answer_text": "Città del Vaticano",
                "is_correct": 1
            },
            {
                "answer_id": 24353,
                "answer_text": "Firenze",
                "is_correct": 0
            },
            {
                "answer_id": 24355,
                "answer_text": "Napoli",
                "is_correct": 0
            },
            {
                "answer_id": 24354,
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
        "id": 4971,
        "question_text": "Qual è il pianeta più grande del sistema solare?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 19984,
                "answer_text": "Giove",
                "is_correct": 1
            },
            {
                "answer_id": 19985,
                "answer_text": "Saturno",
                "is_correct": 0
            },
            {
                "answer_id": 19986,
                "answer_text": "Nettuno",
                "is_correct": 0
            },
            {
                "answer_id": 19987,
                "answer_text": "Urano",
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
        "id": 28024,
        "question_text": "Chi ha scritto 'Il giovane Holden'?",
        "category": "Cultura Generale",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 51098,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 51097,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 51096,
                "answer_text": "J.D. Salinger",
                "is_correct": 1
            },
            {
                "answer_id": 51099,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
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
        "id": 30024,
        "question_text": "Chi ha scritto 'Il conte di Montecristo'?",
        "category": "Cultura Generale",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 55096,
                "answer_text": "Alexandre Dumas",
                "is_correct": 1
            },
            {
                "answer_id": 55098,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 55097,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 55099,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6166,
        "question_text": "Qual è la montagna più alta del mondo?",
        "category": "Cultura Generale",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 24367,
                "answer_text": "Makalu",
                "is_correct": 0
            },
            {
                "answer_id": 24364,
                "answer_text": "Everest",
                "is_correct": 1
            },
            {
                "answer_id": 24366,
                "answer_text": "Kangchenjunga",
                "is_correct": 0
            },
            {
                "answer_id": 24365,
                "answer_text": "K2",
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
        "id": 4973,
        "question_text": "Chi ha dipinto 'La notte stellata'?",
        "category": "Arte",
        "answers": [
            {
                "answer_id": 19992,
                "answer_text": "Vincent van Gogh",
                "is_correct": 1
            },
            {
                "answer_id": 19993,
                "answer_text": "Claude Monet",
                "is_correct": 0
            },
            {
                "answer_id": 19994,
                "answer_text": "Pablo Picasso",
                "is_correct": 0
            },
            {
                "answer_id": 19995,
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
        "id": 27024,
        "question_text": "Chi ha scritto 'Delitto e castigo'?",
        "category": "Cultura Generale",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 49097,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 49098,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 49099,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 49096,
                "answer_text": "Fëdor Dostoevskij",
                "is_correct": 1
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
        "id": 4978,
        "question_text": "Chi è il fondatore di Microsoft?",
        "category": "Tecnologia",
        "answers": [
            {
                "answer_id": 20012,
                "answer_text": "Bill Gates",
                "is_correct": 1
            },
            {
                "answer_id": 20013,
                "answer_text": "Steve Jobs",
                "is_correct": 0
            },
            {
                "answer_id": 20014,
                "answer_text": "Mark Zuckerberg",
                "is_correct": 0
            },
            {
                "answer_id": 20015,
                "answer_text": "Elon Musk",
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
        "id": 5027,
        "question_text": "Chi ha dipinto 'La nascita di Venere'?",
        "category": "Arte",
        "answers": [
            {
                "answer_id": 20208,
                "answer_text": "Sandro Botticelli",
                "is_correct": 1
            },
            {
                "answer_id": 20209,
                "answer_text": "Leonardo da Vinci",
                "is_correct": 0
            },
            {
                "answer_id": 20210,
                "answer_text": "Michelangelo",
                "is_correct": 0
            },
            {
                "answer_id": 20211,
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
        "id": 5009,
        "question_text": "Quanti elementi ha la tavola periodica?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20136,
                "answer_text": "118",
                "is_correct": 1
            },
            {
                "answer_id": 20137,
                "answer_text": "112",
                "is_correct": 0
            },
            {
                "answer_id": 20138,
                "answer_text": "120",
                "is_correct": 0
            },
            {
                "answer_id": 20139,
                "answer_text": "108",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5865,
        "question_text": "Chi ha fondato Microsoft?",
        "category": "Informatica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23161,
                "answer_text": "3a3dfc7e",
                "is_correct": 0
            },
            {
                "answer_id": 23162,
                "answer_text": "f57a8096",
                "is_correct": 0
            },
            {
                "answer_id": 23160,
                "answer_text": "Bill Gates",
                "is_correct": 1
            },
            {
                "answer_id": 23163,
                "answer_text": "e2dc669d",
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
        "id": 32020,
        "question_text": "Chi ha scritto 'Guerra e pace'?",
        "category": "Cultura Generale",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 59080,
                "answer_text": "Lev Tolstoj",
                "is_correct": 1
            },
            {
                "answer_id": 59083,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 59082,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 59081,
                "answer_text": "Gabriele D’Annunzio",
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
        "id": 5045,
        "question_text": "Chi ha composto 'La Traviata'?",
        "category": "Musica",
        "answers": [
            {
                "answer_id": 20280,
                "answer_text": "Giuseppe Verdi",
                "is_correct": 1
            },
            {
                "answer_id": 20281,
                "answer_text": "Puccini",
                "is_correct": 0
            },
            {
                "answer_id": 20282,
                "answer_text": "Rossini",
                "is_correct": 0
            },
            {
                "answer_id": 20283,
                "answer_text": "Donizetti",
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
        "id": 31021,
        "question_text": "Chi ha scritto 'Don Chisciotte'?",
        "category": "Cultura Generale",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 57087,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 57086,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 57084,
                "answer_text": "Miguel de Cervantes",
                "is_correct": 1
            },
            {
                "answer_id": 57085,
                "answer_text": "Gabriele D’Annunzio",
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
        "id": 5859,
        "question_text": "Quante ossa ha il corpo umano adulto?",
        "category": "Medicina",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 23137,
                "answer_text": "02f3742a",
                "is_correct": 0
            },
            {
                "answer_id": 23139,
                "answer_text": "c19d099a",
                "is_correct": 0
            },
            {
                "answer_id": 23138,
                "answer_text": "7983c227",
                "is_correct": 0
            },
            {
                "answer_id": 23136,
                "answer_text": "206",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 4993,
        "question_text": "Chi ha composto 'Il flauto magico'?",
        "category": "Musica",
        "answers": [
            {
                "answer_id": 20072,
                "answer_text": "Wolfgang Amadeus Mozart",
                "is_correct": 1
            },
            {
                "answer_id": 20073,
                "answer_text": "Ludwig van Beethoven",
                "is_correct": 0
            },
            {
                "answer_id": 20074,
                "answer_text": "Franz Schubert",
                "is_correct": 0
            },
            {
                "answer_id": 20075,
                "answer_text": "Johann Strauss",
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
    },
    {
        "id": 4968,
        "question_text": "Qual è la capitale del Brasile?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 19972,
                "answer_text": "Brasilia",
                "is_correct": 1
            },
            {
                "answer_id": 19973,
                "answer_text": "Rio de Janeiro",
                "is_correct": 0
            },
            {
                "answer_id": 19974,
                "answer_text": "San Paolo",
                "is_correct": 0
            },
            {
                "answer_id": 19975,
                "answer_text": "Salvador",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 26026,
        "question_text": "Chi ha scritto 'Il ritratto di Dorian Gray'?",
        "category": "Cultura Generale",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 47105,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 47106,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 47107,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 47104,
                "answer_text": "Oscar Wilde",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 4970,
        "question_text": "In che anno fu fondata Roma?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 19980,
                "answer_text": "753 a.C.",
                "is_correct": 1
            },
            {
                "answer_id": 19981,
                "answer_text": "476 d.C.",
                "is_correct": 0
            },
            {
                "answer_id": 19982,
                "answer_text": "1492",
                "is_correct": 0
            },
            {
                "answer_id": 19983,
                "answer_text": "1000 a.C.",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4972,
        "question_text": "Qual è la lingua ufficiale del Brasile?",
        "category": "Cultura Generale",
        "answers": [
            {
                "answer_id": 19988,
                "answer_text": "Portoghese",
                "is_correct": 1
            },
            {
                "answer_id": 19989,
                "answer_text": "Spagnolo",
                "is_correct": 0
            },
            {
                "answer_id": 19990,
                "answer_text": "Inglese",
                "is_correct": 0
            },
            {
                "answer_id": 19991,
                "answer_text": "Italiano",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4974,
        "question_text": "Quante zampe ha un ragno?",
        "category": "Natura",
        "answers": [
            {
                "answer_id": 19996,
                "answer_text": "8",
                "is_correct": 1
            },
            {
                "answer_id": 19997,
                "answer_text": "6",
                "is_correct": 0
            },
            {
                "answer_id": 19998,
                "answer_text": "10",
                "is_correct": 0
            },
            {
                "answer_id": 19999,
                "answer_text": "4",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4975,
        "question_text": "Chi ha scritto la Costituzione degli Stati Uniti?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 20000,
                "answer_text": "James Madison",
                "is_correct": 1
            },
            {
                "answer_id": 20001,
                "answer_text": "George Washington",
                "is_correct": 0
            },
            {
                "answer_id": 20002,
                "answer_text": "Thomas Jefferson",
                "is_correct": 0
            },
            {
                "answer_id": 20003,
                "answer_text": "Benjamin Franklin",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4976,
        "question_text": "Quale strumento musicale ha tasti neri e bianchi?",
        "category": "Musica",
        "answers": [
            {
                "answer_id": 20004,
                "answer_text": "Pianoforte",
                "is_correct": 1
            },
            {
                "answer_id": 20005,
                "answer_text": "Chitarra",
                "is_correct": 0
            },
            {
                "answer_id": 20006,
                "answer_text": "Violino",
                "is_correct": 0
            },
            {
                "answer_id": 20007,
                "answer_text": "Sassofono",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4977,
        "question_text": "Qual è l’elemento chimico con simbolo Na?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20008,
                "answer_text": "Sodio",
                "is_correct": 1
            },
            {
                "answer_id": 20009,
                "answer_text": "Azoto",
                "is_correct": 0
            },
            {
                "answer_id": 20010,
                "answer_text": "Neon",
                "is_correct": 0
            },
            {
                "answer_id": 20011,
                "answer_text": "Zinco",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4979,
        "question_text": "Quanti lati ha un ottagono?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 20016,
                "answer_text": "8",
                "is_correct": 1
            },
            {
                "answer_id": 20017,
                "answer_text": "6",
                "is_correct": 0
            },
            {
                "answer_id": 20018,
                "answer_text": "7",
                "is_correct": 0
            },
            {
                "answer_id": 20019,
                "answer_text": "9",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4980,
        "question_text": "Quale animale è noto per la memoria?",
        "category": "Natura",
        "answers": [
            {
                "answer_id": 20020,
                "answer_text": "Elefante",
                "is_correct": 1
            },
            {
                "answer_id": 20021,
                "answer_text": "Cane",
                "is_correct": 0
            },
            {
                "answer_id": 20022,
                "answer_text": "Gatto",
                "is_correct": 0
            },
            {
                "answer_id": 20023,
                "answer_text": "Cavallo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4981,
        "question_text": "Qual è la religione più diffusa nel mondo?",
        "category": "Cultura Generale",
        "answers": [
            {
                "answer_id": 20024,
                "answer_text": "Cristianesimo",
                "is_correct": 1
            },
            {
                "answer_id": 20025,
                "answer_text": "Islam",
                "is_correct": 0
            },
            {
                "answer_id": 20026,
                "answer_text": "Induismo",
                "is_correct": 0
            },
            {
                "answer_id": 20027,
                "answer_text": "Buddismo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4982,
        "question_text": "Chi ha scritto 'Il Signore degli Anelli'?",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 20028,
                "answer_text": "J.R.R. Tolkien",
                "is_correct": 1
            },
            {
                "answer_id": 20029,
                "answer_text": "C.S. Lewis",
                "is_correct": 0
            },
            {
                "answer_id": 20030,
                "answer_text": "George R.R. Martin",
                "is_correct": 0
            },
            {
                "answer_id": 20031,
                "answer_text": "Stephen King",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4983,
        "question_text": "Quale stato è famoso per la pizza?",
        "category": "Cultura Generale",
        "answers": [
            {
                "answer_id": 20032,
                "answer_text": "Italia",
                "is_correct": 1
            },
            {
                "answer_id": 20033,
                "answer_text": "Francia",
                "is_correct": 0
            },
            {
                "answer_id": 20034,
                "answer_text": "Spagna",
                "is_correct": 0
            },
            {
                "answer_id": 20035,
                "answer_text": "Grecia",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4984,
        "question_text": "Chi è noto come il padre della psicoanalisi?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20036,
                "answer_text": "Sigmund Freud",
                "is_correct": 1
            },
            {
                "answer_id": 20037,
                "answer_text": "Carl Jung",
                "is_correct": 0
            },
            {
                "answer_id": 20038,
                "answer_text": "Jean Piaget",
                "is_correct": 0
            },
            {
                "answer_id": 20039,
                "answer_text": "Erik Erikson",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4985,
        "question_text": "Quante ore ci sono in un giorno?",
        "category": "Cultura Generale",
        "answers": [
            {
                "answer_id": 20040,
                "answer_text": "24",
                "is_correct": 1
            },
            {
                "answer_id": 20041,
                "answer_text": "12",
                "is_correct": 0
            },
            {
                "answer_id": 20042,
                "answer_text": "36",
                "is_correct": 0
            },
            {
                "answer_id": 20043,
                "answer_text": "48",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4986,
        "question_text": "Quale metallo si usa per fabbricare le lattine?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20044,
                "answer_text": "Alluminio",
                "is_correct": 1
            },
            {
                "answer_id": 20045,
                "answer_text": "Ferro",
                "is_correct": 0
            },
            {
                "answer_id": 20046,
                "answer_text": "Zinco",
                "is_correct": 0
            },
            {
                "answer_id": 20047,
                "answer_text": "Piombo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4987,
        "question_text": "Qual è il simbolo della pace?",
        "category": "Cultura Generale",
        "answers": [
            {
                "answer_id": 20048,
                "answer_text": "Colomba",
                "is_correct": 1
            },
            {
                "answer_id": 20049,
                "answer_text": "Aquila",
                "is_correct": 0
            },
            {
                "answer_id": 20050,
                "answer_text": "Leone",
                "is_correct": 0
            },
            {
                "answer_id": 20051,
                "answer_text": "Tigre",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4988,
        "question_text": "In quale sport si usa una mazza e una pallina?",
        "category": "Sport",
        "answers": [
            {
                "answer_id": 20052,
                "answer_text": "Baseball",
                "is_correct": 1
            },
            {
                "answer_id": 20053,
                "answer_text": "Tennis",
                "is_correct": 0
            },
            {
                "answer_id": 20054,
                "answer_text": "Golf",
                "is_correct": 0
            },
            {
                "answer_id": 20055,
                "answer_text": "Hockey",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25081,
        "question_text": "Chi ha scritto 'Il Gattopardo'?",
        "category": "Cultura Generale",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45325,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 45324,
                "answer_text": "Giuseppe Tomasi di Lampedusa",
                "is_correct": 1
            },
            {
                "answer_id": 45327,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 45326,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4990,
        "question_text": "Qual è il continente più piccolo?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 20060,
                "answer_text": "Oceania",
                "is_correct": 1
            },
            {
                "answer_id": 20061,
                "answer_text": "Europa",
                "is_correct": 0
            },
            {
                "answer_id": 20062,
                "answer_text": "Antartide",
                "is_correct": 0
            },
            {
                "answer_id": 20063,
                "answer_text": "Sud America",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4991,
        "question_text": "Quanti pianeti nani ci sono nel sistema solare?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20064,
                "answer_text": "5",
                "is_correct": 1
            },
            {
                "answer_id": 20065,
                "answer_text": "3",
                "is_correct": 0
            },
            {
                "answer_id": 20066,
                "answer_text": "7",
                "is_correct": 0
            },
            {
                "answer_id": 20067,
                "answer_text": "9",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4992,
        "question_text": "Qual è la capitale della Turchia?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 20068,
                "answer_text": "Ankara",
                "is_correct": 1
            },
            {
                "answer_id": 20069,
                "answer_text": "Istanbul",
                "is_correct": 0
            },
            {
                "answer_id": 20070,
                "answer_text": "Smirne",
                "is_correct": 0
            },
            {
                "answer_id": 20071,
                "answer_text": "Bursa",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4994,
        "question_text": "Come si chiama il sistema operativo di Apple?",
        "category": "Tecnologia",
        "answers": [
            {
                "answer_id": 20076,
                "answer_text": "macOS",
                "is_correct": 1
            },
            {
                "answer_id": 20077,
                "answer_text": "Windows",
                "is_correct": 0
            },
            {
                "answer_id": 20078,
                "answer_text": "Linux",
                "is_correct": 0
            },
            {
                "answer_id": 20079,
                "answer_text": "Android",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4995,
        "question_text": "Che tipo di animale è il tonno?",
        "category": "Natura",
        "answers": [
            {
                "answer_id": 20080,
                "answer_text": "Pesce",
                "is_correct": 1
            },
            {
                "answer_id": 20081,
                "answer_text": "Mammifero",
                "is_correct": 0
            },
            {
                "answer_id": 20082,
                "answer_text": "Anfibio",
                "is_correct": 0
            },
            {
                "answer_id": 20083,
                "answer_text": "Rettili",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25078,
        "question_text": "Chi ha scritto 'Se questo è un uomo'?",
        "category": "Cultura Generale",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45313,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 45314,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 45312,
                "answer_text": "Primo Levi",
                "is_correct": 1
            },
            {
                "answer_id": 45315,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4997,
        "question_text": "Qual è l’unità di misura della potenza?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20088,
                "answer_text": "Watt",
                "is_correct": 1
            },
            {
                "answer_id": 20089,
                "answer_text": "Volt",
                "is_correct": 0
            },
            {
                "answer_id": 20090,
                "answer_text": "Ampere",
                "is_correct": 0
            },
            {
                "answer_id": 20091,
                "answer_text": "Ohm",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25098,
        "question_text": "Qual è il numero atomico dell’ossigeno?",
        "category": "Chimica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45394,
                "answer_text": "10",
                "is_correct": 0
            },
            {
                "answer_id": 45395,
                "answer_text": "12",
                "is_correct": 0
            },
            {
                "answer_id": 45392,
                "answer_text": "8",
                "is_correct": 1
            },
            {
                "answer_id": 45393,
                "answer_text": "6",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 4999,
        "question_text": "Quale città ospita il Big Ben?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 20096,
                "answer_text": "Londra",
                "is_correct": 1
            },
            {
                "answer_id": 20097,
                "answer_text": "Parigi",
                "is_correct": 0
            },
            {
                "answer_id": 20098,
                "answer_text": "New York",
                "is_correct": 0
            },
            {
                "answer_id": 20099,
                "answer_text": "Roma",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5001,
        "question_text": "Qual è il fiume più lungo d’Europa?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 20104,
                "answer_text": "Volga",
                "is_correct": 1
            },
            {
                "answer_id": 20105,
                "answer_text": "Danubio",
                "is_correct": 0
            },
            {
                "answer_id": 20106,
                "answer_text": "Reno",
                "is_correct": 0
            },
            {
                "answer_id": 20107,
                "answer_text": "Senna",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6283,
        "question_text": "Chi ha dipinto 'Guernica'?",
        "category": "Arte",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 24833,
                "answer_text": "Salvador Dalí",
                "is_correct": 0
            },
            {
                "answer_id": 24832,
                "answer_text": "Pablo Picasso",
                "is_correct": 1
            },
            {
                "answer_id": 24835,
                "answer_text": "Joan Miró",
                "is_correct": 0
            },
            {
                "answer_id": 24834,
                "answer_text": "Henri Matisse",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5003,
        "question_text": "Quante corde ha un violino?",
        "category": "Musica",
        "answers": [
            {
                "answer_id": 20112,
                "answer_text": "4",
                "is_correct": 1
            },
            {
                "answer_id": 20113,
                "answer_text": "5",
                "is_correct": 0
            },
            {
                "answer_id": 20114,
                "answer_text": "6",
                "is_correct": 0
            },
            {
                "answer_id": 20115,
                "answer_text": "3",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5004,
        "question_text": "Qual è la capitale della Norvegia?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 20116,
                "answer_text": "Oslo",
                "is_correct": 1
            },
            {
                "answer_id": 20117,
                "answer_text": "Bergen",
                "is_correct": 0
            },
            {
                "answer_id": 20118,
                "answer_text": "Stoccolma",
                "is_correct": 0
            },
            {
                "answer_id": 20119,
                "answer_text": "Helsinki",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 27027,
        "question_text": "Chi ha scritto 'La fattoria degli animali'?",
        "category": "Cultura Generale",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 49108,
                "answer_text": "George Orwell",
                "is_correct": 1
            },
            {
                "answer_id": 49110,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 49109,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 49111,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5006,
        "question_text": "Come si chiama la scienza che studia le piante?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20124,
                "answer_text": "Botanica",
                "is_correct": 1
            },
            {
                "answer_id": 20125,
                "answer_text": "Zoologia",
                "is_correct": 0
            },
            {
                "answer_id": 20126,
                "answer_text": "Geologia",
                "is_correct": 0
            },
            {
                "answer_id": 20127,
                "answer_text": "Chimica",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5007,
        "question_text": "Quale sport si gioca con bastoni e un disco?",
        "category": "Sport",
        "answers": [
            {
                "answer_id": 20128,
                "answer_text": "Hockey su ghiaccio",
                "is_correct": 1
            },
            {
                "answer_id": 20129,
                "answer_text": "Golf",
                "is_correct": 0
            },
            {
                "answer_id": 20130,
                "answer_text": "Baseball",
                "is_correct": 0
            },
            {
                "answer_id": 20131,
                "answer_text": "Cricket",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5008,
        "question_text": "Qual è il monte più alto d’Africa?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 20132,
                "answer_text": "Kilimangiaro",
                "is_correct": 1
            },
            {
                "answer_id": 20133,
                "answer_text": "Everest",
                "is_correct": 0
            },
            {
                "answer_id": 20134,
                "answer_text": "Monte Kenya",
                "is_correct": 0
            },
            {
                "answer_id": 20135,
                "answer_text": "Monte Bianco",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5010,
        "question_text": "Quale animale depone le uova ma allatta i piccoli?",
        "category": "Natura",
        "answers": [
            {
                "answer_id": 20140,
                "answer_text": "Ornitorinco",
                "is_correct": 1
            },
            {
                "answer_id": 20141,
                "answer_text": "Delfino",
                "is_correct": 0
            },
            {
                "answer_id": 20142,
                "answer_text": "Foca",
                "is_correct": 0
            },
            {
                "answer_id": 20143,
                "answer_text": "Tartaruga",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5897,
        "question_text": "Chi ha scoperto l’America?",
        "category": "Cultura Generale",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 23288,
                "answer_text": "Cristoforo Colombo",
                "is_correct": 1
            },
            {
                "answer_id": 23290,
                "answer_text": "e4ea0e35",
                "is_correct": 0
            },
            {
                "answer_id": 23289,
                "answer_text": "9b2c498f",
                "is_correct": 0
            },
            {
                "answer_id": 23291,
                "answer_text": "fe7626b5",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5012,
        "question_text": "Quanti pianeti hanno anelli visibili?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20148,
                "answer_text": "4",
                "is_correct": 1
            },
            {
                "answer_id": 20149,
                "answer_text": "2",
                "is_correct": 0
            },
            {
                "answer_id": 20150,
                "answer_text": "3",
                "is_correct": 0
            },
            {
                "answer_id": 20151,
                "answer_text": "5",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5014,
        "question_text": "Come si chiama l’inno nazionale italiano?",
        "category": "Cultura Generale",
        "answers": [
            {
                "answer_id": 20156,
                "answer_text": "Il Canto degli Italiani",
                "is_correct": 1
            },
            {
                "answer_id": 20157,
                "answer_text": "Fratelli d’Italia",
                "is_correct": 0
            },
            {
                "answer_id": 20158,
                "answer_text": "Inno di Mameli",
                "is_correct": 0
            },
            {
                "answer_id": 20159,
                "answer_text": "Italia mia",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5015,
        "question_text": "Quale pianeta è più vicino alla Terra?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20160,
                "answer_text": "Venere",
                "is_correct": 1
            },
            {
                "answer_id": 20161,
                "answer_text": "Marte",
                "is_correct": 0
            },
            {
                "answer_id": 20162,
                "answer_text": "Mercurio",
                "is_correct": 0
            },
            {
                "answer_id": 20163,
                "answer_text": "Giove",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5016,
        "question_text": "In quale città si trova il museo del Louvre?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 20164,
                "answer_text": "Parigi",
                "is_correct": 1
            },
            {
                "answer_id": 20165,
                "answer_text": "Madrid",
                "is_correct": 0
            },
            {
                "answer_id": 20166,
                "answer_text": "Berlino",
                "is_correct": 0
            },
            {
                "answer_id": 20167,
                "answer_text": "Roma",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5017,
        "question_text": "Chi è il fondatore di Facebook?",
        "category": "Tecnologia",
        "answers": [
            {
                "answer_id": 20168,
                "answer_text": "Mark Zuckerberg",
                "is_correct": 1
            },
            {
                "answer_id": 20169,
                "answer_text": "Elon Musk",
                "is_correct": 0
            },
            {
                "answer_id": 20170,
                "answer_text": "Jeff Bezos",
                "is_correct": 0
            },
            {
                "answer_id": 20171,
                "answer_text": "Larry Page",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5018,
        "question_text": "Quale strumento misura la velocità del vento?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20172,
                "answer_text": "Anemometro",
                "is_correct": 1
            },
            {
                "answer_id": 20173,
                "answer_text": "Barometro",
                "is_correct": 0
            },
            {
                "answer_id": 20174,
                "answer_text": "Termometro",
                "is_correct": 0
            },
            {
                "answer_id": 20175,
                "answer_text": "Altimetro",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5019,
        "question_text": "Qual è il colore complementare del rosso?",
        "category": "Arte",
        "answers": [
            {
                "answer_id": 20176,
                "answer_text": "Verde",
                "is_correct": 1
            },
            {
                "answer_id": 20177,
                "answer_text": "Blu",
                "is_correct": 0
            },
            {
                "answer_id": 20178,
                "answer_text": "Giallo",
                "is_correct": 0
            },
            {
                "answer_id": 20179,
                "answer_text": "Viola",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5020,
        "question_text": "Quale sport è noto per Wimbledon?",
        "category": "Sport",
        "answers": [
            {
                "answer_id": 20180,
                "answer_text": "Tennis",
                "is_correct": 1
            },
            {
                "answer_id": 20181,
                "answer_text": "Golf",
                "is_correct": 0
            },
            {
                "answer_id": 20182,
                "answer_text": "Calcio",
                "is_correct": 0
            },
            {
                "answer_id": 20183,
                "answer_text": "Cricket",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5021,
        "question_text": "Quale frutto è simbolo di New York?",
        "category": "Cultura Generale",
        "answers": [
            {
                "answer_id": 20184,
                "answer_text": "Mela",
                "is_correct": 1
            },
            {
                "answer_id": 20185,
                "answer_text": "Banana",
                "is_correct": 0
            },
            {
                "answer_id": 20186,
                "answer_text": "Arancia",
                "is_correct": 0
            },
            {
                "answer_id": 20187,
                "answer_text": "Uva",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5022,
        "question_text": "Quale stato ha come capitale Austin?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 20188,
                "answer_text": "Texas",
                "is_correct": 1
            },
            {
                "answer_id": 20189,
                "answer_text": "California",
                "is_correct": 0
            },
            {
                "answer_id": 20190,
                "answer_text": "Florida",
                "is_correct": 0
            },
            {
                "answer_id": 20191,
                "answer_text": "Nevada",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5023,
        "question_text": "Chi ha scritto 'Inferno' nella Divina Commedia?",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 20192,
                "answer_text": "Dante Alighieri",
                "is_correct": 1
            },
            {
                "answer_id": 20193,
                "answer_text": "Petrarca",
                "is_correct": 0
            },
            {
                "answer_id": 20194,
                "answer_text": "Boccaccio",
                "is_correct": 0
            },
            {
                "answer_id": 20195,
                "answer_text": "Manzoni",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5024,
        "question_text": "Quale animale è più grande sulla Terra?",
        "category": "Natura",
        "answers": [
            {
                "answer_id": 20196,
                "answer_text": "Balena blu",
                "is_correct": 1
            },
            {
                "answer_id": 20197,
                "answer_text": "Elefante africano",
                "is_correct": 0
            },
            {
                "answer_id": 20198,
                "answer_text": "Squalo bianco",
                "is_correct": 0
            },
            {
                "answer_id": 20199,
                "answer_text": "Ippopotamo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5025,
        "question_text": "Come si chiama il pianeta più lontano dal Sole?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20200,
                "answer_text": "Nettuno",
                "is_correct": 1
            },
            {
                "answer_id": 20201,
                "answer_text": "Plutone",
                "is_correct": 0
            },
            {
                "answer_id": 20202,
                "answer_text": "Urano",
                "is_correct": 0
            },
            {
                "answer_id": 20203,
                "answer_text": "Saturno",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5026,
        "question_text": "Qual è la capitale della Svezia?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 20204,
                "answer_text": "Stoccolma",
                "is_correct": 1
            },
            {
                "answer_id": 20205,
                "answer_text": "Oslo",
                "is_correct": 0
            },
            {
                "answer_id": 20206,
                "answer_text": "Copenaghen",
                "is_correct": 0
            },
            {
                "answer_id": 20207,
                "answer_text": "Helsinki",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5028,
        "question_text": "Quale paese ha come moneta lo yen?",
        "category": "Economia",
        "answers": [
            {
                "answer_id": 20212,
                "answer_text": "Giappone",
                "is_correct": 1
            },
            {
                "answer_id": 20213,
                "answer_text": "Cina",
                "is_correct": 0
            },
            {
                "answer_id": 20214,
                "answer_text": "Corea",
                "is_correct": 0
            },
            {
                "answer_id": 20215,
                "answer_text": "Thailandia",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5029,
        "question_text": "Quale animale rappresenta la Cina?",
        "category": "Natura",
        "answers": [
            {
                "answer_id": 20216,
                "answer_text": "Panda",
                "is_correct": 1
            },
            {
                "answer_id": 20217,
                "answer_text": "Drago",
                "is_correct": 0
            },
            {
                "answer_id": 20218,
                "answer_text": "Tigre",
                "is_correct": 0
            },
            {
                "answer_id": 20219,
                "answer_text": "Scimmia",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5030,
        "question_text": "Quanti gradi ha un angolo retto?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 20220,
                "answer_text": "90",
                "is_correct": 1
            },
            {
                "answer_id": 20221,
                "answer_text": "45",
                "is_correct": 0
            },
            {
                "answer_id": 20222,
                "answer_text": "60",
                "is_correct": 0
            },
            {
                "answer_id": 20223,
                "answer_text": "120",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5032,
        "question_text": "Qual è l’isola più grande del mondo?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 20228,
                "answer_text": "Groenlandia",
                "is_correct": 1
            },
            {
                "answer_id": 20229,
                "answer_text": "Australia",
                "is_correct": 0
            },
            {
                "answer_id": 20230,
                "answer_text": "Islanda",
                "is_correct": 0
            },
            {
                "answer_id": 20231,
                "answer_text": "Borneo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 26029,
        "question_text": "Chi ha scritto 'Il barone rampante'?",
        "category": "Cultura Generale",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 47116,
                "answer_text": "Italo Calvino",
                "is_correct": 1
            },
            {
                "answer_id": 47119,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 47117,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 47118,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5034,
        "question_text": "Che tipo di energia sfrutta un pannello solare?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20236,
                "answer_text": "Energia solare",
                "is_correct": 1
            },
            {
                "answer_id": 20237,
                "answer_text": "Eolica",
                "is_correct": 0
            },
            {
                "answer_id": 20238,
                "answer_text": "Idraulica",
                "is_correct": 0
            },
            {
                "answer_id": 20239,
                "answer_text": "Geotermica",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5035,
        "question_text": "Chi è l’autore della teoria dell’evoluzione?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20240,
                "answer_text": "Charles Darwin",
                "is_correct": 1
            },
            {
                "answer_id": 20241,
                "answer_text": "Lamarck",
                "is_correct": 0
            },
            {
                "answer_id": 20242,
                "answer_text": "Newton",
                "is_correct": 0
            },
            {
                "answer_id": 20243,
                "answer_text": "Galileo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5036,
        "question_text": "Quale animale è simbolo della saggezza?",
        "category": "Natura",
        "answers": [
            {
                "answer_id": 20244,
                "answer_text": "Gufo",
                "is_correct": 1
            },
            {
                "answer_id": 20245,
                "answer_text": "Volpe",
                "is_correct": 0
            },
            {
                "answer_id": 20246,
                "answer_text": "Cane",
                "is_correct": 0
            },
            {
                "answer_id": 20247,
                "answer_text": "Gatto",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5037,
        "question_text": "Quanti minuti ci sono in 3 ore?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 20248,
                "answer_text": "180",
                "is_correct": 1
            },
            {
                "answer_id": 20249,
                "answer_text": "120",
                "is_correct": 0
            },
            {
                "answer_id": 20250,
                "answer_text": "150",
                "is_correct": 0
            },
            {
                "answer_id": 20251,
                "answer_text": "200",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5038,
        "question_text": "Qual è il continente con più stati?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 20252,
                "answer_text": "Africa",
                "is_correct": 1
            },
            {
                "answer_id": 20253,
                "answer_text": "Asia",
                "is_correct": 0
            },
            {
                "answer_id": 20254,
                "answer_text": "Europa",
                "is_correct": 0
            },
            {
                "answer_id": 20255,
                "answer_text": "America",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5039,
        "question_text": "Chi ha scritto 'Anna Karenina'?",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 20256,
                "answer_text": "Lev Tolstoj",
                "is_correct": 1
            },
            {
                "answer_id": 20257,
                "answer_text": "Cechov",
                "is_correct": 0
            },
            {
                "answer_id": 20258,
                "answer_text": "Dostoevskij",
                "is_correct": 0
            },
            {
                "answer_id": 20259,
                "answer_text": "Gorkij",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5040,
        "question_text": "Qual è l’animale simbolo della savana?",
        "category": "Natura",
        "answers": [
            {
                "answer_id": 20260,
                "answer_text": "Leone",
                "is_correct": 1
            },
            {
                "answer_id": 20261,
                "answer_text": "Elefante",
                "is_correct": 0
            },
            {
                "answer_id": 20262,
                "answer_text": "Zebra",
                "is_correct": 0
            },
            {
                "answer_id": 20263,
                "answer_text": "Giraffa",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5041,
        "question_text": "Qual è la capitale della Finlandia?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 20264,
                "answer_text": "Helsinki",
                "is_correct": 1
            },
            {
                "answer_id": 20265,
                "answer_text": "Tallin",
                "is_correct": 0
            },
            {
                "answer_id": 20266,
                "answer_text": "Riga",
                "is_correct": 0
            },
            {
                "answer_id": 20267,
                "answer_text": "Oslo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5043,
        "question_text": "Quale unità misura la distanza nello spazio?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20272,
                "answer_text": "Anno luce",
                "is_correct": 1
            },
            {
                "answer_id": 20273,
                "answer_text": "Kilometro",
                "is_correct": 0
            },
            {
                "answer_id": 20274,
                "answer_text": "Parsec",
                "is_correct": 0
            },
            {
                "answer_id": 20275,
                "answer_text": "Miglio",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5044,
        "question_text": "Qual è la capitale dell’India?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 20276,
                "answer_text": "Nuova Delhi",
                "is_correct": 1
            },
            {
                "answer_id": 20277,
                "answer_text": "Mumbai",
                "is_correct": 0
            },
            {
                "answer_id": 20278,
                "answer_text": "Bangalore",
                "is_correct": 0
            },
            {
                "answer_id": 20279,
                "answer_text": "Calcutta",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5046,
        "question_text": "Qual è il simbolo chimico del piombo?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20284,
                "answer_text": "Pb",
                "is_correct": 1
            },
            {
                "answer_id": 20285,
                "answer_text": "P",
                "is_correct": 0
            },
            {
                "answer_id": 20286,
                "answer_text": "Po",
                "is_correct": 0
            },
            {
                "answer_id": 20287,
                "answer_text": "Pt",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5047,
        "question_text": "Quale pianeta ha una grande macchia rossa?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20288,
                "answer_text": "Giove",
                "is_correct": 1
            },
            {
                "answer_id": 20289,
                "answer_text": "Marte",
                "is_correct": 0
            },
            {
                "answer_id": 20290,
                "answer_text": "Saturno",
                "is_correct": 0
            },
            {
                "answer_id": 20291,
                "answer_text": "Nettuno",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5048,
        "question_text": "Qual è la capitale di Francia?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 20292,
                "answer_text": "Parigi",
                "is_correct": 1
            },
            {
                "answer_id": 20293,
                "answer_text": "Milano",
                "is_correct": 0
            },
            {
                "answer_id": 20294,
                "answer_text": "Torino",
                "is_correct": 0
            },
            {
                "answer_id": 20295,
                "answer_text": "Napoli",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5049,
        "question_text": "Qual è la capitale di Germania?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 20296,
                "answer_text": "Berlino",
                "is_correct": 1
            },
            {
                "answer_id": 20297,
                "answer_text": "Milano",
                "is_correct": 0
            },
            {
                "answer_id": 20298,
                "answer_text": "Torino",
                "is_correct": 0
            },
            {
                "answer_id": 20299,
                "answer_text": "Napoli",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5050,
        "question_text": "Qual è la capitale di Italia?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 20300,
                "answer_text": "Roma",
                "is_correct": 1
            },
            {
                "answer_id": 20301,
                "answer_text": "Milano",
                "is_correct": 0
            },
            {
                "answer_id": 20302,
                "answer_text": "Torino",
                "is_correct": 0
            },
            {
                "answer_id": 20303,
                "answer_text": "Napoli",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5051,
        "question_text": "Qual è la capitale di Spagna?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 20304,
                "answer_text": "Madrid",
                "is_correct": 1
            },
            {
                "answer_id": 20305,
                "answer_text": "Milano",
                "is_correct": 0
            },
            {
                "answer_id": 20306,
                "answer_text": "Torino",
                "is_correct": 0
            },
            {
                "answer_id": 20307,
                "answer_text": "Napoli",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5052,
        "question_text": "Qual è la capitale di Portogallo?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 20308,
                "answer_text": "Lisbona",
                "is_correct": 1
            },
            {
                "answer_id": 20309,
                "answer_text": "Milano",
                "is_correct": 0
            },
            {
                "answer_id": 20310,
                "answer_text": "Torino",
                "is_correct": 0
            },
            {
                "answer_id": 20311,
                "answer_text": "Napoli",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5053,
        "question_text": "Qual è la capitale di Austria?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 20312,
                "answer_text": "Vienna",
                "is_correct": 1
            },
            {
                "answer_id": 20313,
                "answer_text": "Milano",
                "is_correct": 0
            },
            {
                "answer_id": 20314,
                "answer_text": "Torino",
                "is_correct": 0
            },
            {
                "answer_id": 20315,
                "answer_text": "Napoli",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5054,
        "question_text": "Qual è la capitale di Grecia?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 20316,
                "answer_text": "Atene",
                "is_correct": 1
            },
            {
                "answer_id": 20317,
                "answer_text": "Milano",
                "is_correct": 0
            },
            {
                "answer_id": 20318,
                "answer_text": "Torino",
                "is_correct": 0
            },
            {
                "answer_id": 20319,
                "answer_text": "Napoli",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5055,
        "question_text": "Qual è la capitale di Olanda?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 20320,
                "answer_text": "Amsterdam",
                "is_correct": 1
            },
            {
                "answer_id": 20321,
                "answer_text": "Milano",
                "is_correct": 0
            },
            {
                "answer_id": 20322,
                "answer_text": "Torino",
                "is_correct": 0
            },
            {
                "answer_id": 20323,
                "answer_text": "Napoli",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5056,
        "question_text": "Qual è la capitale di Belgio?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 20324,
                "answer_text": "Bruxelles",
                "is_correct": 1
            },
            {
                "answer_id": 20325,
                "answer_text": "Milano",
                "is_correct": 0
            },
            {
                "answer_id": 20326,
                "answer_text": "Torino",
                "is_correct": 0
            },
            {
                "answer_id": 20327,
                "answer_text": "Napoli",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5057,
        "question_text": "Qual è la capitale di Svizzera?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 20328,
                "answer_text": "Berna",
                "is_correct": 1
            },
            {
                "answer_id": 20329,
                "answer_text": "Milano",
                "is_correct": 0
            },
            {
                "answer_id": 20330,
                "answer_text": "Torino",
                "is_correct": 0
            },
            {
                "answer_id": 20331,
                "answer_text": "Napoli",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5058,
        "question_text": "Chi ha scritto 'La divina commedia'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 20332,
                "answer_text": "Dante Alighieri",
                "is_correct": 1
            },
            {
                "answer_id": 20333,
                "answer_text": "Italo Calvino",
                "is_correct": 0
            },
            {
                "answer_id": 20334,
                "answer_text": "Alberto Moravia",
                "is_correct": 0
            },
            {
                "answer_id": 20335,
                "answer_text": "Umberto Eco",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5059,
        "question_text": "Chi ha scritto 'I Malavoglia'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 20336,
                "answer_text": "Giovanni Verga",
                "is_correct": 1
            },
            {
                "answer_id": 20337,
                "answer_text": "Italo Calvino",
                "is_correct": 0
            },
            {
                "answer_id": 20338,
                "answer_text": "Alberto Moravia",
                "is_correct": 0
            },
            {
                "answer_id": 20339,
                "answer_text": "Umberto Eco",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5820,
        "question_text": "Chi ha scritto 'Uno, nessuno e centomila'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 22782,
                "answer_text": "Dacia Maraini",
                "is_correct": 0
            },
            {
                "answer_id": 22780,
                "answer_text": "Luigi Pirandello",
                "is_correct": 1
            },
            {
                "answer_id": 22781,
                "answer_text": "Umberto Eco",
                "is_correct": 0
            },
            {
                "answer_id": 22783,
                "answer_text": "Alberto Moravia",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5810,
        "question_text": "Chi ha scritto 'Il fu Mattia Pascal'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 22743,
                "answer_text": "Alberto Moravia",
                "is_correct": 0
            },
            {
                "answer_id": 22740,
                "answer_text": "Luigi Pirandello",
                "is_correct": 1
            },
            {
                "answer_id": 22741,
                "answer_text": "Umberto Eco",
                "is_correct": 0
            },
            {
                "answer_id": 22742,
                "answer_text": "Dacia Maraini",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5062,
        "question_text": "Chi ha scritto 'L’isola del tesoro'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 20348,
                "answer_text": "Robert L. Stevenson",
                "is_correct": 1
            },
            {
                "answer_id": 20349,
                "answer_text": "Italo Calvino",
                "is_correct": 0
            },
            {
                "answer_id": 20350,
                "answer_text": "Alberto Moravia",
                "is_correct": 0
            },
            {
                "answer_id": 20351,
                "answer_text": "Umberto Eco",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5063,
        "question_text": "Chi ha scritto 'Il conte di Montecristo'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 20352,
                "answer_text": "Alexandre Dumas",
                "is_correct": 1
            },
            {
                "answer_id": 20353,
                "answer_text": "Italo Calvino",
                "is_correct": 0
            },
            {
                "answer_id": 20354,
                "answer_text": "Alberto Moravia",
                "is_correct": 0
            },
            {
                "answer_id": 20355,
                "answer_text": "Umberto Eco",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5064,
        "question_text": "Chi ha scritto 'Orgoglio e pregiudizio'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 20356,
                "answer_text": "Jane Austen",
                "is_correct": 1
            },
            {
                "answer_id": 20357,
                "answer_text": "Italo Calvino",
                "is_correct": 0
            },
            {
                "answer_id": 20358,
                "answer_text": "Alberto Moravia",
                "is_correct": 0
            },
            {
                "answer_id": 20359,
                "answer_text": "Umberto Eco",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5065,
        "question_text": "Chi ha scritto 'Il vecchio e il mare'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 20360,
                "answer_text": "Ernest Hemingway",
                "is_correct": 1
            },
            {
                "answer_id": 20361,
                "answer_text": "Italo Calvino",
                "is_correct": 0
            },
            {
                "answer_id": 20362,
                "answer_text": "Alberto Moravia",
                "is_correct": 0
            },
            {
                "answer_id": 20363,
                "answer_text": "Umberto Eco",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5826,
        "question_text": "Chi ha scritto 'La coscienza di Zeno'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 22804,
                "answer_text": "Italo Svevo",
                "is_correct": 1
            },
            {
                "answer_id": 22806,
                "answer_text": "Dacia Maraini",
                "is_correct": 0
            },
            {
                "answer_id": 22805,
                "answer_text": "Umberto Eco",
                "is_correct": 0
            },
            {
                "answer_id": 22807,
                "answer_text": "Alberto Moravia",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5067,
        "question_text": "Chi ha scritto 'Il piccolo principe'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 20368,
                "answer_text": "Antoine de Saint-Exupéry",
                "is_correct": 1
            },
            {
                "answer_id": 20369,
                "answer_text": "Italo Calvino",
                "is_correct": 0
            },
            {
                "answer_id": 20370,
                "answer_text": "Alberto Moravia",
                "is_correct": 0
            },
            {
                "answer_id": 20371,
                "answer_text": "Umberto Eco",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5068,
        "question_text": "In quale anno è accaduto questo evento: Caduta del muro di Berlino?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 20372,
                "answer_text": "1989",
                "is_correct": 1
            },
            {
                "answer_id": 20373,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 20374,
                "answer_text": "1600",
                "is_correct": 0
            },
            {
                "answer_id": 20375,
                "answer_text": "1700",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5069,
        "question_text": "In quale anno è accaduto questo evento: Scoperta dell’America?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 20376,
                "answer_text": "1492",
                "is_correct": 1
            },
            {
                "answer_id": 20377,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 20378,
                "answer_text": "1600",
                "is_correct": 0
            },
            {
                "answer_id": 20379,
                "answer_text": "1700",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5070,
        "question_text": "In quale anno è accaduto questo evento: Inizio Prima Guerra Mondiale?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 20380,
                "answer_text": "1914",
                "is_correct": 1
            },
            {
                "answer_id": 20381,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 20382,
                "answer_text": "1600",
                "is_correct": 0
            },
            {
                "answer_id": 20383,
                "answer_text": "1700",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5071,
        "question_text": "In quale anno è accaduto questo evento: Inizio Seconda Guerra Mondiale?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 20384,
                "answer_text": "1939",
                "is_correct": 1
            },
            {
                "answer_id": 20385,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 20386,
                "answer_text": "1600",
                "is_correct": 0
            },
            {
                "answer_id": 20387,
                "answer_text": "1700",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5072,
        "question_text": "In quale anno è accaduto questo evento: Fine Seconda Guerra Mondiale?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 20388,
                "answer_text": "1945",
                "is_correct": 1
            },
            {
                "answer_id": 20389,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 20390,
                "answer_text": "1600",
                "is_correct": 0
            },
            {
                "answer_id": 20391,
                "answer_text": "1700",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5073,
        "question_text": "In quale anno è accaduto questo evento: Fondazione di Roma?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 20392,
                "answer_text": "753 a.C.",
                "is_correct": 1
            },
            {
                "answer_id": 20393,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 20394,
                "answer_text": "1600",
                "is_correct": 0
            },
            {
                "answer_id": 20395,
                "answer_text": "1700",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5074,
        "question_text": "In quale anno è accaduto questo evento: Attacco alle Torri Gemelle?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 20396,
                "answer_text": "2001",
                "is_correct": 1
            },
            {
                "answer_id": 20397,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 20398,
                "answer_text": "1600",
                "is_correct": 0
            },
            {
                "answer_id": 20399,
                "answer_text": "1700",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5075,
        "question_text": "In quale anno è accaduto questo evento: Rivoluzione francese?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 20400,
                "answer_text": "1789",
                "is_correct": 1
            },
            {
                "answer_id": 20401,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 20402,
                "answer_text": "1600",
                "is_correct": 0
            },
            {
                "answer_id": 20403,
                "answer_text": "1700",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5076,
        "question_text": "In quale anno è accaduto questo evento: Unificazione d’Italia?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 20404,
                "answer_text": "1861",
                "is_correct": 1
            },
            {
                "answer_id": 20405,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 20406,
                "answer_text": "1600",
                "is_correct": 0
            },
            {
                "answer_id": 20407,
                "answer_text": "1700",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5077,
        "question_text": "In quale anno è accaduto questo evento: Firma della Costituzione italiana?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 20408,
                "answer_text": "1948",
                "is_correct": 1
            },
            {
                "answer_id": 20409,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 20410,
                "answer_text": "1600",
                "is_correct": 0
            },
            {
                "answer_id": 20411,
                "answer_text": "1700",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5078,
        "question_text": "Qual è il simbolo chimico di Idrogeno?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20412,
                "answer_text": "H",
                "is_correct": 1
            },
            {
                "answer_id": 20413,
                "answer_text": "K",
                "is_correct": 0
            },
            {
                "answer_id": 20414,
                "answer_text": "Zn",
                "is_correct": 0
            },
            {
                "answer_id": 20415,
                "answer_text": "Sn",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5079,
        "question_text": "Qual è il simbolo chimico di Ossigeno?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20416,
                "answer_text": "O",
                "is_correct": 1
            },
            {
                "answer_id": 20417,
                "answer_text": "K",
                "is_correct": 0
            },
            {
                "answer_id": 20418,
                "answer_text": "Zn",
                "is_correct": 0
            },
            {
                "answer_id": 20419,
                "answer_text": "Sn",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5080,
        "question_text": "Qual è il simbolo chimico di Azoto?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20420,
                "answer_text": "N",
                "is_correct": 1
            },
            {
                "answer_id": 20421,
                "answer_text": "K",
                "is_correct": 0
            },
            {
                "answer_id": 20422,
                "answer_text": "Zn",
                "is_correct": 0
            },
            {
                "answer_id": 20423,
                "answer_text": "Sn",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5081,
        "question_text": "Qual è il simbolo chimico di Carbonio?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20424,
                "answer_text": "C",
                "is_correct": 1
            },
            {
                "answer_id": 20425,
                "answer_text": "K",
                "is_correct": 0
            },
            {
                "answer_id": 20426,
                "answer_text": "Zn",
                "is_correct": 0
            },
            {
                "answer_id": 20427,
                "answer_text": "Sn",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5082,
        "question_text": "Qual è il simbolo chimico di Ferro?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20428,
                "answer_text": "Fe",
                "is_correct": 1
            },
            {
                "answer_id": 20429,
                "answer_text": "K",
                "is_correct": 0
            },
            {
                "answer_id": 20430,
                "answer_text": "Zn",
                "is_correct": 0
            },
            {
                "answer_id": 20431,
                "answer_text": "Sn",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5083,
        "question_text": "Qual è il simbolo chimico di Oro?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20432,
                "answer_text": "Au",
                "is_correct": 1
            },
            {
                "answer_id": 20433,
                "answer_text": "K",
                "is_correct": 0
            },
            {
                "answer_id": 20434,
                "answer_text": "Zn",
                "is_correct": 0
            },
            {
                "answer_id": 20435,
                "answer_text": "Sn",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5084,
        "question_text": "Qual è il simbolo chimico di Argento?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20436,
                "answer_text": "Ag",
                "is_correct": 1
            },
            {
                "answer_id": 20437,
                "answer_text": "K",
                "is_correct": 0
            },
            {
                "answer_id": 20438,
                "answer_text": "Zn",
                "is_correct": 0
            },
            {
                "answer_id": 20439,
                "answer_text": "Sn",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5085,
        "question_text": "Qual è il simbolo chimico di Piombo?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20440,
                "answer_text": "Pb",
                "is_correct": 1
            },
            {
                "answer_id": 20441,
                "answer_text": "K",
                "is_correct": 0
            },
            {
                "answer_id": 20442,
                "answer_text": "Zn",
                "is_correct": 0
            },
            {
                "answer_id": 20443,
                "answer_text": "Sn",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5086,
        "question_text": "Qual è il simbolo chimico di Sodio?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20444,
                "answer_text": "Na",
                "is_correct": 1
            },
            {
                "answer_id": 20445,
                "answer_text": "K",
                "is_correct": 0
            },
            {
                "answer_id": 20446,
                "answer_text": "Zn",
                "is_correct": 0
            },
            {
                "answer_id": 20447,
                "answer_text": "Sn",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5087,
        "question_text": "Qual è il simbolo chimico di Rame?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 20448,
                "answer_text": "Cu",
                "is_correct": 1
            },
            {
                "answer_id": 20449,
                "answer_text": "K",
                "is_correct": 0
            },
            {
                "answer_id": 20450,
                "answer_text": "Zn",
                "is_correct": 0
            },
            {
                "answer_id": 20451,
                "answer_text": "Sn",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5248,
        "question_text": "Qual è la capitale del Messico?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21492,
                "answer_text": "Città del Messico",
                "is_correct": 1
            },
            {
                "answer_id": 21493,
                "answer_text": "Lima",
                "is_correct": 0
            },
            {
                "answer_id": 21494,
                "answer_text": "Caracas",
                "is_correct": 0
            },
            {
                "answer_id": 21495,
                "answer_text": "Santiago",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5250,
        "question_text": "Qual è la capitale del Cina?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21500,
                "answer_text": "Pechino",
                "is_correct": 1
            },
            {
                "answer_id": 21501,
                "answer_text": "Lima",
                "is_correct": 0
            },
            {
                "answer_id": 21502,
                "answer_text": "Caracas",
                "is_correct": 0
            },
            {
                "answer_id": 21503,
                "answer_text": "Santiago",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5252,
        "question_text": "Qual è la capitale del Russia?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21508,
                "answer_text": "Mosca",
                "is_correct": 1
            },
            {
                "answer_id": 21509,
                "answer_text": "Lima",
                "is_correct": 0
            },
            {
                "answer_id": 21510,
                "answer_text": "Caracas",
                "is_correct": 0
            },
            {
                "answer_id": 21511,
                "answer_text": "Santiago",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5253,
        "question_text": "Qual è la capitale del India?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21512,
                "answer_text": "Nuova Delhi",
                "is_correct": 1
            },
            {
                "answer_id": 21513,
                "answer_text": "Lima",
                "is_correct": 0
            },
            {
                "answer_id": 21514,
                "answer_text": "Caracas",
                "is_correct": 0
            },
            {
                "answer_id": 21515,
                "answer_text": "Santiago",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5254,
        "question_text": "Qual è la capitale del Australia?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21516,
                "answer_text": "Canberra",
                "is_correct": 1
            },
            {
                "answer_id": 21517,
                "answer_text": "Lima",
                "is_correct": 0
            },
            {
                "answer_id": 21518,
                "answer_text": "Caracas",
                "is_correct": 0
            },
            {
                "answer_id": 21519,
                "answer_text": "Santiago",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5255,
        "question_text": "Qual è la capitale del Egitto?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21520,
                "answer_text": "Il Cairo",
                "is_correct": 1
            },
            {
                "answer_id": 21521,
                "answer_text": "Lima",
                "is_correct": 0
            },
            {
                "answer_id": 21522,
                "answer_text": "Caracas",
                "is_correct": 0
            },
            {
                "answer_id": 21523,
                "answer_text": "Santiago",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5256,
        "question_text": "Qual è la capitale del Sudafrica?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21524,
                "answer_text": "Pretoria",
                "is_correct": 1
            },
            {
                "answer_id": 21525,
                "answer_text": "Lima",
                "is_correct": 0
            },
            {
                "answer_id": 21526,
                "answer_text": "Caracas",
                "is_correct": 0
            },
            {
                "answer_id": 21527,
                "answer_text": "Santiago",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5257,
        "question_text": "Qual è la capitale del Argentina?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21528,
                "answer_text": "Buenos Aires",
                "is_correct": 1
            },
            {
                "answer_id": 21529,
                "answer_text": "Lima",
                "is_correct": 0
            },
            {
                "answer_id": 21530,
                "answer_text": "Caracas",
                "is_correct": 0
            },
            {
                "answer_id": 21531,
                "answer_text": "Santiago",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5258,
        "question_text": "In che anno è successo: Battaglia di Waterloo?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 21532,
                "answer_text": "1815",
                "is_correct": 1
            },
            {
                "answer_id": 21533,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 21534,
                "answer_text": "1900",
                "is_correct": 0
            },
            {
                "answer_id": 21535,
                "answer_text": "1500",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5259,
        "question_text": "In che anno è successo: Sbarco in Normandia?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 21536,
                "answer_text": "1944",
                "is_correct": 1
            },
            {
                "answer_id": 21537,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 21538,
                "answer_text": "1900",
                "is_correct": 0
            },
            {
                "answer_id": 21539,
                "answer_text": "1500",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5260,
        "question_text": "In che anno è successo: Rivoluzione industriale?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 21540,
                "answer_text": "1760",
                "is_correct": 1
            },
            {
                "answer_id": 21541,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 21542,
                "answer_text": "1900",
                "is_correct": 0
            },
            {
                "answer_id": 21543,
                "answer_text": "1500",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5261,
        "question_text": "In che anno è successo: Crisi del 1929?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 21544,
                "answer_text": "1929",
                "is_correct": 1
            },
            {
                "answer_id": 21545,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 21546,
                "answer_text": "1900",
                "is_correct": 0
            },
            {
                "answer_id": 21547,
                "answer_text": "1500",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5262,
        "question_text": "In che anno è successo: Caduta dell’Impero Romano d’Occidente?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 21548,
                "answer_text": "476",
                "is_correct": 1
            },
            {
                "answer_id": 21549,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 21550,
                "answer_text": "1900",
                "is_correct": 0
            },
            {
                "answer_id": 21551,
                "answer_text": "1500",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5263,
        "question_text": "In che anno è successo: Unificazione della Germania?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 21552,
                "answer_text": "1871",
                "is_correct": 1
            },
            {
                "answer_id": 21553,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 21554,
                "answer_text": "1900",
                "is_correct": 0
            },
            {
                "answer_id": 21555,
                "answer_text": "1500",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5264,
        "question_text": "In che anno è successo: Attentato a Sarajevo?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 21556,
                "answer_text": "1914",
                "is_correct": 1
            },
            {
                "answer_id": 21557,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 21558,
                "answer_text": "1900",
                "is_correct": 0
            },
            {
                "answer_id": 21559,
                "answer_text": "1500",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5265,
        "question_text": "In che anno è successo: Fine dell’Impero Ottomano?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 21560,
                "answer_text": "1922",
                "is_correct": 1
            },
            {
                "answer_id": 21561,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 21562,
                "answer_text": "1900",
                "is_correct": 0
            },
            {
                "answer_id": 21563,
                "answer_text": "1500",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5266,
        "question_text": "In che anno è successo: Trattato di Versailles?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 21564,
                "answer_text": "1919",
                "is_correct": 1
            },
            {
                "answer_id": 21565,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 21566,
                "answer_text": "1900",
                "is_correct": 0
            },
            {
                "answer_id": 21567,
                "answer_text": "1500",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5267,
        "question_text": "In che anno è successo: Nascita dell’ONU?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 21568,
                "answer_text": "1945",
                "is_correct": 1
            },
            {
                "answer_id": 21569,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 21570,
                "answer_text": "1900",
                "is_correct": 0
            },
            {
                "answer_id": 21571,
                "answer_text": "1500",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5268,
        "question_text": "Qual è il simbolo chimico di Zinco?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 21572,
                "answer_text": "Zn",
                "is_correct": 1
            },
            {
                "answer_id": 21573,
                "answer_text": "Sn",
                "is_correct": 0
            },
            {
                "answer_id": 21574,
                "answer_text": "Pb",
                "is_correct": 0
            },
            {
                "answer_id": 21575,
                "answer_text": "Co",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5269,
        "question_text": "Qual è il simbolo chimico di Calcio?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 21576,
                "answer_text": "Ca",
                "is_correct": 1
            },
            {
                "answer_id": 21577,
                "answer_text": "Sn",
                "is_correct": 0
            },
            {
                "answer_id": 21578,
                "answer_text": "Pb",
                "is_correct": 0
            },
            {
                "answer_id": 21579,
                "answer_text": "Co",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5270,
        "question_text": "Qual è il simbolo chimico di Litio?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 21580,
                "answer_text": "Li",
                "is_correct": 1
            },
            {
                "answer_id": 21581,
                "answer_text": "Sn",
                "is_correct": 0
            },
            {
                "answer_id": 21582,
                "answer_text": "Pb",
                "is_correct": 0
            },
            {
                "answer_id": 21583,
                "answer_text": "Co",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5271,
        "question_text": "Qual è il simbolo chimico di Alluminio?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 21584,
                "answer_text": "Al",
                "is_correct": 1
            },
            {
                "answer_id": 21585,
                "answer_text": "Sn",
                "is_correct": 0
            },
            {
                "answer_id": 21586,
                "answer_text": "Pb",
                "is_correct": 0
            },
            {
                "answer_id": 21587,
                "answer_text": "Co",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5272,
        "question_text": "Qual è il simbolo chimico di Potassio?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 21588,
                "answer_text": "K",
                "is_correct": 1
            },
            {
                "answer_id": 21589,
                "answer_text": "Sn",
                "is_correct": 0
            },
            {
                "answer_id": 21590,
                "answer_text": "Pb",
                "is_correct": 0
            },
            {
                "answer_id": 21591,
                "answer_text": "Co",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5273,
        "question_text": "Qual è il simbolo chimico di Elio?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 21592,
                "answer_text": "He",
                "is_correct": 1
            },
            {
                "answer_id": 21593,
                "answer_text": "Sn",
                "is_correct": 0
            },
            {
                "answer_id": 21594,
                "answer_text": "Pb",
                "is_correct": 0
            },
            {
                "answer_id": 21595,
                "answer_text": "Co",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5274,
        "question_text": "Qual è il simbolo chimico di Neon?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 21596,
                "answer_text": "Ne",
                "is_correct": 1
            },
            {
                "answer_id": 21597,
                "answer_text": "Sn",
                "is_correct": 0
            },
            {
                "answer_id": 21598,
                "answer_text": "Pb",
                "is_correct": 0
            },
            {
                "answer_id": 21599,
                "answer_text": "Co",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5275,
        "question_text": "Qual è il simbolo chimico di Bromo?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 21600,
                "answer_text": "Br",
                "is_correct": 1
            },
            {
                "answer_id": 21601,
                "answer_text": "Sn",
                "is_correct": 0
            },
            {
                "answer_id": 21602,
                "answer_text": "Pb",
                "is_correct": 0
            },
            {
                "answer_id": 21603,
                "answer_text": "Co",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5276,
        "question_text": "Qual è il simbolo chimico di Cloro?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 21604,
                "answer_text": "Cl",
                "is_correct": 1
            },
            {
                "answer_id": 21605,
                "answer_text": "Sn",
                "is_correct": 0
            },
            {
                "answer_id": 21606,
                "answer_text": "Pb",
                "is_correct": 0
            },
            {
                "answer_id": 21607,
                "answer_text": "Co",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5277,
        "question_text": "Qual è il simbolo chimico di Iodio?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 21608,
                "answer_text": "I",
                "is_correct": 1
            },
            {
                "answer_id": 21609,
                "answer_text": "Sn",
                "is_correct": 0
            },
            {
                "answer_id": 21610,
                "answer_text": "Pb",
                "is_correct": 0
            },
            {
                "answer_id": 21611,
                "answer_text": "Co",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5278,
        "question_text": "Chi ha scritto 'Il nome della rosa'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 21612,
                "answer_text": "Umberto Eco",
                "is_correct": 1
            },
            {
                "answer_id": 21613,
                "answer_text": "Stephen King",
                "is_correct": 0
            },
            {
                "answer_id": 21614,
                "answer_text": "Jules Verne",
                "is_correct": 0
            },
            {
                "answer_id": 21615,
                "answer_text": "Mark Twain",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5279,
        "question_text": "Chi ha scritto 'Cent'anni di solitudine'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 21616,
                "answer_text": "Gabriel García Márquez",
                "is_correct": 1
            },
            {
                "answer_id": 21617,
                "answer_text": "Stephen King",
                "is_correct": 0
            },
            {
                "answer_id": 21618,
                "answer_text": "Jules Verne",
                "is_correct": 0
            },
            {
                "answer_id": 21619,
                "answer_text": "Mark Twain",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5280,
        "question_text": "Chi ha scritto 'Moby Dick'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 21620,
                "answer_text": "Herman Melville",
                "is_correct": 1
            },
            {
                "answer_id": 21621,
                "answer_text": "Stephen King",
                "is_correct": 0
            },
            {
                "answer_id": 21622,
                "answer_text": "Jules Verne",
                "is_correct": 0
            },
            {
                "answer_id": 21623,
                "answer_text": "Mark Twain",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5281,
        "question_text": "Chi ha scritto 'Il grande Gatsby'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 21624,
                "answer_text": "F. Scott Fitzgerald",
                "is_correct": 1
            },
            {
                "answer_id": 21625,
                "answer_text": "Stephen King",
                "is_correct": 0
            },
            {
                "answer_id": 21626,
                "answer_text": "Jules Verne",
                "is_correct": 0
            },
            {
                "answer_id": 21627,
                "answer_text": "Mark Twain",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5282,
        "question_text": "Chi ha scritto 'Dracula'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 21628,
                "answer_text": "Bram Stoker",
                "is_correct": 1
            },
            {
                "answer_id": 21629,
                "answer_text": "Stephen King",
                "is_correct": 0
            },
            {
                "answer_id": 21630,
                "answer_text": "Jules Verne",
                "is_correct": 0
            },
            {
                "answer_id": 21631,
                "answer_text": "Mark Twain",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5283,
        "question_text": "Chi ha scritto '1984'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 21632,
                "answer_text": "George Orwell",
                "is_correct": 1
            },
            {
                "answer_id": 21633,
                "answer_text": "Stephen King",
                "is_correct": 0
            },
            {
                "answer_id": 21634,
                "answer_text": "Jules Verne",
                "is_correct": 0
            },
            {
                "answer_id": 21635,
                "answer_text": "Mark Twain",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5284,
        "question_text": "Chi ha scritto 'La fattoria degli animali'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 21636,
                "answer_text": "George Orwell",
                "is_correct": 1
            },
            {
                "answer_id": 21637,
                "answer_text": "Stephen King",
                "is_correct": 0
            },
            {
                "answer_id": 21638,
                "answer_text": "Jules Verne",
                "is_correct": 0
            },
            {
                "answer_id": 21639,
                "answer_text": "Mark Twain",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5285,
        "question_text": "Chi ha scritto 'Il giovane Holden'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 21640,
                "answer_text": "J.D. Salinger",
                "is_correct": 1
            },
            {
                "answer_id": 21641,
                "answer_text": "Stephen King",
                "is_correct": 0
            },
            {
                "answer_id": 21642,
                "answer_text": "Jules Verne",
                "is_correct": 0
            },
            {
                "answer_id": 21643,
                "answer_text": "Mark Twain",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5286,
        "question_text": "Chi ha scritto 'Il maestro e Margherita'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 21644,
                "answer_text": "Michail Bulgakov",
                "is_correct": 1
            },
            {
                "answer_id": 21645,
                "answer_text": "Stephen King",
                "is_correct": 0
            },
            {
                "answer_id": 21646,
                "answer_text": "Jules Verne",
                "is_correct": 0
            },
            {
                "answer_id": 21647,
                "answer_text": "Mark Twain",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5287,
        "question_text": "Chi ha scritto 'Don Chisciotte'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 21648,
                "answer_text": "Miguel de Cervantes",
                "is_correct": 1
            },
            {
                "answer_id": 21649,
                "answer_text": "Stephen King",
                "is_correct": 0
            },
            {
                "answer_id": 21650,
                "answer_text": "Jules Verne",
                "is_correct": 0
            },
            {
                "answer_id": 21651,
                "answer_text": "Mark Twain",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5288,
        "question_text": "Quanto fa 12 x 12?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 21652,
                "answer_text": "144",
                "is_correct": 1
            },
            {
                "answer_id": 21653,
                "answer_text": "100",
                "is_correct": 0
            },
            {
                "answer_id": 21654,
                "answer_text": "200",
                "is_correct": 0
            },
            {
                "answer_id": 21655,
                "answer_text": "50",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5289,
        "question_text": "Quanto fa 15 x 3?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 21656,
                "answer_text": "45",
                "is_correct": 1
            },
            {
                "answer_id": 21657,
                "answer_text": "100",
                "is_correct": 0
            },
            {
                "answer_id": 21658,
                "answer_text": "200",
                "is_correct": 0
            },
            {
                "answer_id": 21659,
                "answer_text": "50",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5290,
        "question_text": "Quanto fa 64 ÷ 8?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 21660,
                "answer_text": "8",
                "is_correct": 1
            },
            {
                "answer_id": 21661,
                "answer_text": "100",
                "is_correct": 0
            },
            {
                "answer_id": 21662,
                "answer_text": "200",
                "is_correct": 0
            },
            {
                "answer_id": 21663,
                "answer_text": "50",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5291,
        "question_text": "Quanto fa 7 x 6?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 21664,
                "answer_text": "42",
                "is_correct": 1
            },
            {
                "answer_id": 21665,
                "answer_text": "100",
                "is_correct": 0
            },
            {
                "answer_id": 21666,
                "answer_text": "200",
                "is_correct": 0
            },
            {
                "answer_id": 21667,
                "answer_text": "50",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5292,
        "question_text": "Quanto fa 100 ÷ 10?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 21668,
                "answer_text": "10",
                "is_correct": 1
            },
            {
                "answer_id": 21669,
                "answer_text": "100",
                "is_correct": 0
            },
            {
                "answer_id": 21670,
                "answer_text": "200",
                "is_correct": 0
            },
            {
                "answer_id": 21671,
                "answer_text": "50",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5293,
        "question_text": "Quanto fa 9 x 9?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 21672,
                "answer_text": "81",
                "is_correct": 1
            },
            {
                "answer_id": 21673,
                "answer_text": "100",
                "is_correct": 0
            },
            {
                "answer_id": 21674,
                "answer_text": "200",
                "is_correct": 0
            },
            {
                "answer_id": 21675,
                "answer_text": "50",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5835,
        "question_text": "Quanto fa 14 + 28?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 22841,
                "answer_text": "98",
                "is_correct": 0
            },
            {
                "answer_id": 22842,
                "answer_text": "90",
                "is_correct": 0
            },
            {
                "answer_id": 22843,
                "answer_text": "101",
                "is_correct": 0
            },
            {
                "answer_id": 22840,
                "answer_text": "42",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5295,
        "question_text": "Quanto fa 50 - 17?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 21680,
                "answer_text": "33",
                "is_correct": 1
            },
            {
                "answer_id": 21681,
                "answer_text": "100",
                "is_correct": 0
            },
            {
                "answer_id": 21682,
                "answer_text": "200",
                "is_correct": 0
            },
            {
                "answer_id": 21683,
                "answer_text": "50",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5296,
        "question_text": "Quanto fa 11 x 11?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 21684,
                "answer_text": "121",
                "is_correct": 1
            },
            {
                "answer_id": 21685,
                "answer_text": "100",
                "is_correct": 0
            },
            {
                "answer_id": 21686,
                "answer_text": "200",
                "is_correct": 0
            },
            {
                "answer_id": 21687,
                "answer_text": "50",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5297,
        "question_text": "Quanto fa 100 + 200?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 21688,
                "answer_text": "300",
                "is_correct": 1
            },
            {
                "answer_id": 21689,
                "answer_text": "100",
                "is_correct": 0
            },
            {
                "answer_id": 21690,
                "answer_text": "200",
                "is_correct": 0
            },
            {
                "answer_id": 21691,
                "answer_text": "50",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5541,
        "question_text": "Qual è la funzione principale del Polmone?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 21665,
                "answer_text": "Produrre energia",
                "is_correct": 0
            },
            {
                "answer_id": 21666,
                "answer_text": "Regolare la temperatura",
                "is_correct": 0
            },
            {
                "answer_id": 21664,
                "answer_text": "Scambiare ossigeno e anidride carbonica",
                "is_correct": 1
            },
            {
                "answer_id": 21667,
                "answer_text": "Controllare i muscoli",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5533,
        "question_text": "In che anno è accaduto: Fine guerra del Vietnam?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 21634,
                "answer_text": "2000",
                "is_correct": 0
            },
            {
                "answer_id": 21633,
                "answer_text": "1900",
                "is_correct": 0
            },
            {
                "answer_id": 21632,
                "answer_text": "1975",
                "is_correct": 1
            },
            {
                "answer_id": 21635,
                "answer_text": "1850",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5528,
        "question_text": "Qual è la capitale del Marocco?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21614,
                "answer_text": "Tunis",
                "is_correct": 0
            },
            {
                "answer_id": 21615,
                "answer_text": "Kigali",
                "is_correct": 0
            },
            {
                "answer_id": 21613,
                "answer_text": "Accra",
                "is_correct": 0
            },
            {
                "answer_id": 21612,
                "answer_text": "Rabat",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5486,
        "question_text": "In che anno è accaduto: Inizio regno di Elisabetta II?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 21444,
                "answer_text": "1952",
                "is_correct": 1
            },
            {
                "answer_id": 21445,
                "answer_text": "1900",
                "is_correct": 0
            },
            {
                "answer_id": 21447,
                "answer_text": "1850",
                "is_correct": 0
            },
            {
                "answer_id": 21446,
                "answer_text": "2000",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5490,
        "question_text": "Chi è l'autore de 'La casa degli spiriti'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 21461,
                "answer_text": "Oscar Wilde",
                "is_correct": 0
            },
            {
                "answer_id": 21463,
                "answer_text": "Charles Dickens",
                "is_correct": 0
            },
            {
                "answer_id": 21462,
                "answer_text": "Jules Verne",
                "is_correct": 0
            },
            {
                "answer_id": 21460,
                "answer_text": "Isabel Allende",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5455,
        "question_text": "Qual è la capitale del Cile?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21323,
                "answer_text": "Kigali",
                "is_correct": 0
            },
            {
                "answer_id": 21321,
                "answer_text": "Accra",
                "is_correct": 0
            },
            {
                "answer_id": 21322,
                "answer_text": "Tunis",
                "is_correct": 0
            },
            {
                "answer_id": 21320,
                "answer_text": "Santiago",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5382,
        "question_text": "Qual è la capitale del Venezuela?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21031,
                "answer_text": "Kigali",
                "is_correct": 0
            },
            {
                "answer_id": 21028,
                "answer_text": "Caracas",
                "is_correct": 1
            },
            {
                "answer_id": 21029,
                "answer_text": "Accra",
                "is_correct": 0
            },
            {
                "answer_id": 21030,
                "answer_text": "Tunis",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5546,
        "question_text": "In che anno è accaduto: Crisi dei missili di Cuba?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 21684,
                "answer_text": "1962",
                "is_correct": 1
            },
            {
                "answer_id": 21686,
                "answer_text": "2000",
                "is_correct": 0
            },
            {
                "answer_id": 21685,
                "answer_text": "1900",
                "is_correct": 0
            },
            {
                "answer_id": 21687,
                "answer_text": "1850",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5545,
        "question_text": "Chi è l'autore de 'Delitto e castigo'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 21682,
                "answer_text": "Jules Verne",
                "is_correct": 0
            },
            {
                "answer_id": 21683,
                "answer_text": "Charles Dickens",
                "is_correct": 0
            },
            {
                "answer_id": 21680,
                "answer_text": "Fëdor Dostoevskij",
                "is_correct": 1
            },
            {
                "answer_id": 21681,
                "answer_text": "Oscar Wilde",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5492,
        "question_text": "Qual è la funzione principale del Reni?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 21470,
                "answer_text": "Regolare la temperatura",
                "is_correct": 0
            },
            {
                "answer_id": 21468,
                "answer_text": "Filtrare il sangue",
                "is_correct": 1
            },
            {
                "answer_id": 21471,
                "answer_text": "Controllare i muscoli",
                "is_correct": 0
            },
            {
                "answer_id": 21469,
                "answer_text": "Produrre energia",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5543,
        "question_text": "Qual è la capitale del Kenya?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21674,
                "answer_text": "Tunis",
                "is_correct": 0
            },
            {
                "answer_id": 21672,
                "answer_text": "Nairobi",
                "is_correct": 1
            },
            {
                "answer_id": 21673,
                "answer_text": "Accra",
                "is_correct": 0
            },
            {
                "answer_id": 21675,
                "answer_text": "Kigali",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5463,
        "question_text": "Qual è la funzione principale del Intestino tenue?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 21352,
                "answer_text": "Assorbire i nutrienti",
                "is_correct": 1
            },
            {
                "answer_id": 21353,
                "answer_text": "Produrre energia",
                "is_correct": 0
            },
            {
                "answer_id": 21354,
                "answer_text": "Regolare la temperatura",
                "is_correct": 0
            },
            {
                "answer_id": 21355,
                "answer_text": "Controllare i muscoli",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5509,
        "question_text": "Qual è la capitale del Vietnam?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21537,
                "answer_text": "Accra",
                "is_correct": 0
            },
            {
                "answer_id": 21536,
                "answer_text": "Hanoi",
                "is_correct": 1
            },
            {
                "answer_id": 21538,
                "answer_text": "Tunis",
                "is_correct": 0
            },
            {
                "answer_id": 21539,
                "answer_text": "Kigali",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5512,
        "question_text": "Quanto fa 60 x 2?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 21551,
                "answer_text": "77",
                "is_correct": 0
            },
            {
                "answer_id": 21549,
                "answer_text": "110",
                "is_correct": 0
            },
            {
                "answer_id": 21550,
                "answer_text": "99",
                "is_correct": 0
            },
            {
                "answer_id": 21548,
                "answer_text": "120",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5363,
        "question_text": "Quanto fa 13 x 7?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 20955,
                "answer_text": "77",
                "is_correct": 0
            },
            {
                "answer_id": 20952,
                "answer_text": "91",
                "is_correct": 1
            },
            {
                "answer_id": 20953,
                "answer_text": "110",
                "is_correct": 0
            },
            {
                "answer_id": 20954,
                "answer_text": "99",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5499,
        "question_text": "Qual è la capitale del Nigeria?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21498,
                "answer_text": "Tunis",
                "is_correct": 0
            },
            {
                "answer_id": 21497,
                "answer_text": "Accra",
                "is_correct": 0
            },
            {
                "answer_id": 21496,
                "answer_text": "Abuja",
                "is_correct": 1
            },
            {
                "answer_id": 21499,
                "answer_text": "Kigali",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5521,
        "question_text": "Qual è la funzione principale del Fegato?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 21584,
                "answer_text": "Depurare il sangue",
                "is_correct": 1
            },
            {
                "answer_id": 21586,
                "answer_text": "Regolare la temperatura",
                "is_correct": 0
            },
            {
                "answer_id": 21585,
                "answer_text": "Produrre energia",
                "is_correct": 0
            },
            {
                "answer_id": 21587,
                "answer_text": "Controllare i muscoli",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5839,
        "question_text": "Quanto fa 144 ÷ 12?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 22857,
                "answer_text": "98",
                "is_correct": 0
            },
            {
                "answer_id": 22856,
                "answer_text": "12",
                "is_correct": 1
            },
            {
                "answer_id": 22859,
                "answer_text": "101",
                "is_correct": 0
            },
            {
                "answer_id": 22858,
                "answer_text": "90",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5520,
        "question_text": "In che anno è accaduto: Scoperta della penicillina?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 21583,
                "answer_text": "1850",
                "is_correct": 0
            },
            {
                "answer_id": 21580,
                "answer_text": "1928",
                "is_correct": 1
            },
            {
                "answer_id": 21582,
                "answer_text": "2000",
                "is_correct": 0
            },
            {
                "answer_id": 21581,
                "answer_text": "1900",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5519,
        "question_text": "Chi è l'autore de 'Le notti bianche'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 21579,
                "answer_text": "Charles Dickens",
                "is_correct": 0
            },
            {
                "answer_id": 21578,
                "answer_text": "Jules Verne",
                "is_correct": 0
            },
            {
                "answer_id": 21577,
                "answer_text": "Oscar Wilde",
                "is_correct": 0
            },
            {
                "answer_id": 21576,
                "answer_text": "Fëdor Dostoevskij",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5425,
        "question_text": "Chi è l'autore de 'Il processo'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 21201,
                "answer_text": "Oscar Wilde",
                "is_correct": 0
            },
            {
                "answer_id": 21200,
                "answer_text": "Franz Kafka",
                "is_correct": 1
            },
            {
                "answer_id": 21202,
                "answer_text": "Jules Verne",
                "is_correct": 0
            },
            {
                "answer_id": 21203,
                "answer_text": "Charles Dickens",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5454,
        "question_text": "Chi è l'autore de 'Il rosso e il nero'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 21318,
                "answer_text": "Jules Verne",
                "is_correct": 0
            },
            {
                "answer_id": 21319,
                "answer_text": "Charles Dickens",
                "is_correct": 0
            },
            {
                "answer_id": 21316,
                "answer_text": "Stendhal",
                "is_correct": 1
            },
            {
                "answer_id": 21317,
                "answer_text": "Oscar Wilde",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5464,
        "question_text": "Qual è la funzione principale del Stomaco?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 21358,
                "answer_text": "Regolare la temperatura",
                "is_correct": 0
            },
            {
                "answer_id": 21357,
                "answer_text": "Produrre energia",
                "is_correct": 0
            },
            {
                "answer_id": 21356,
                "answer_text": "Digerire il cibo",
                "is_correct": 1
            },
            {
                "answer_id": 21359,
                "answer_text": "Controllare i muscoli",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5500,
        "question_text": "Qual è la capitale del Filippine?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21503,
                "answer_text": "Kigali",
                "is_correct": 0
            },
            {
                "answer_id": 21501,
                "answer_text": "Accra",
                "is_correct": 0
            },
            {
                "answer_id": 21500,
                "answer_text": "Manila",
                "is_correct": 1
            },
            {
                "answer_id": 21502,
                "answer_text": "Tunis",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5510,
        "question_text": "Qual è la funzione principale del Pancreas?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 21542,
                "answer_text": "Regolare la temperatura",
                "is_correct": 0
            },
            {
                "answer_id": 21543,
                "answer_text": "Controllare i muscoli",
                "is_correct": 0
            },
            {
                "answer_id": 21540,
                "answer_text": "Produrre insulina",
                "is_correct": 1
            },
            {
                "answer_id": 21541,
                "answer_text": "Produrre energia",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5497,
        "question_text": "Qual è la capitale del Colombia?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21490,
                "answer_text": "Tunis",
                "is_correct": 0
            },
            {
                "answer_id": 21491,
                "answer_text": "Kigali",
                "is_correct": 0
            },
            {
                "answer_id": 21489,
                "answer_text": "Accra",
                "is_correct": 0
            },
            {
                "answer_id": 21488,
                "answer_text": "Bogotá",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5527,
        "question_text": "Qual è la funzione principale del Midollo spinale?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 21611,
                "answer_text": "Controllare i muscoli",
                "is_correct": 0
            },
            {
                "answer_id": 21610,
                "answer_text": "Regolare la temperatura",
                "is_correct": 0
            },
            {
                "answer_id": 21608,
                "answer_text": "Trasmettere segnali nervosi",
                "is_correct": 1
            },
            {
                "answer_id": 21609,
                "answer_text": "Produrre energia",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5504,
        "question_text": "Quanto fa 90 - 27?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 21516,
                "answer_text": "63",
                "is_correct": 1
            },
            {
                "answer_id": 21518,
                "answer_text": "99",
                "is_correct": 0
            },
            {
                "answer_id": 21517,
                "answer_text": "110",
                "is_correct": 0
            },
            {
                "answer_id": 21519,
                "answer_text": "77",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5517,
        "question_text": "Chi è l'autore de 'Le avventure di Tom Sawyer'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 21571,
                "answer_text": "Charles Dickens",
                "is_correct": 0
            },
            {
                "answer_id": 21570,
                "answer_text": "Jules Verne",
                "is_correct": 0
            },
            {
                "answer_id": 21569,
                "answer_text": "Oscar Wilde",
                "is_correct": 0
            },
            {
                "answer_id": 21568,
                "answer_text": "Mark Twain",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5488,
        "question_text": "In che anno è accaduto: Morte di Giulio Cesare?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 21453,
                "answer_text": "1900",
                "is_correct": 0
            },
            {
                "answer_id": 21452,
                "answer_text": "44 a.C.",
                "is_correct": 1
            },
            {
                "answer_id": 21455,
                "answer_text": "1850",
                "is_correct": 0
            },
            {
                "answer_id": 21454,
                "answer_text": "2000",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5471,
        "question_text": "In che anno è accaduto: Proclamazione della Repubblica Italiana?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 21387,
                "answer_text": "1850",
                "is_correct": 0
            },
            {
                "answer_id": 21386,
                "answer_text": "2000",
                "is_correct": 0
            },
            {
                "answer_id": 21384,
                "answer_text": "1946",
                "is_correct": 1
            },
            {
                "answer_id": 21385,
                "answer_text": "1900",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5516,
        "question_text": "In che anno è accaduto: Caduta dell'URSS?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 21565,
                "answer_text": "1900",
                "is_correct": 0
            },
            {
                "answer_id": 21567,
                "answer_text": "1850",
                "is_correct": 0
            },
            {
                "answer_id": 21564,
                "answer_text": "1991",
                "is_correct": 1
            },
            {
                "answer_id": 21566,
                "answer_text": "2000",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5440,
        "question_text": "Quanto fa 15 + 18?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 21260,
                "answer_text": "33",
                "is_correct": 1
            },
            {
                "answer_id": 21263,
                "answer_text": "77",
                "is_correct": 0
            },
            {
                "answer_id": 21262,
                "answer_text": "99",
                "is_correct": 0
            },
            {
                "answer_id": 21261,
                "answer_text": "110",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5511,
        "question_text": "Qual è la capitale del Perù?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21544,
                "answer_text": "Lima",
                "is_correct": 1
            },
            {
                "answer_id": 21545,
                "answer_text": "Accra",
                "is_correct": 0
            },
            {
                "answer_id": 21547,
                "answer_text": "Kigali",
                "is_correct": 0
            },
            {
                "answer_id": 21546,
                "answer_text": "Tunis",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5432,
        "question_text": "In che anno è accaduto: Prima luna piena documentata?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 21231,
                "answer_text": "1850",
                "is_correct": 0
            },
            {
                "answer_id": 21228,
                "answer_text": "1969",
                "is_correct": 1
            },
            {
                "answer_id": 21230,
                "answer_text": "2000",
                "is_correct": 0
            },
            {
                "answer_id": 21229,
                "answer_text": "1900",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5540,
        "question_text": "In che anno è accaduto: Elezione di Barack Obama?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 21663,
                "answer_text": "1850",
                "is_correct": 0
            },
            {
                "answer_id": 21661,
                "answer_text": "1900",
                "is_correct": 0
            },
            {
                "answer_id": 21662,
                "answer_text": "2000",
                "is_correct": 0
            },
            {
                "answer_id": 21660,
                "answer_text": "2008",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5537,
        "question_text": "Quanto fa 81 ÷ 9?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 21650,
                "answer_text": "99",
                "is_correct": 0
            },
            {
                "answer_id": 21651,
                "answer_text": "77",
                "is_correct": 0
            },
            {
                "answer_id": 21649,
                "answer_text": "110",
                "is_correct": 0
            },
            {
                "answer_id": 21648,
                "answer_text": "9",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5542,
        "question_text": "Quanto fa 25 x 4?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 21669,
                "answer_text": "110",
                "is_correct": 0
            },
            {
                "answer_id": 21670,
                "answer_text": "99",
                "is_correct": 0
            },
            {
                "answer_id": 21671,
                "answer_text": "77",
                "is_correct": 0
            },
            {
                "answer_id": 21668,
                "answer_text": "100",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5437,
        "question_text": "Qual è la funzione principale del Cervello?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 21251,
                "answer_text": "Controllare i muscoli",
                "is_correct": 0
            },
            {
                "answer_id": 21248,
                "answer_text": "Controllare le funzioni corporee",
                "is_correct": 1
            },
            {
                "answer_id": 21249,
                "answer_text": "Produrre energia",
                "is_correct": 0
            },
            {
                "answer_id": 21250,
                "answer_text": "Regolare la temperatura",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5530,
        "question_text": "In che anno è accaduto: Presa della Bastiglia?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 21622,
                "answer_text": "2000",
                "is_correct": 0
            },
            {
                "answer_id": 21621,
                "answer_text": "1900",
                "is_correct": 0
            },
            {
                "answer_id": 21620,
                "answer_text": "1789",
                "is_correct": 1
            },
            {
                "answer_id": 21623,
                "answer_text": "1850",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5544,
        "question_text": "Quanto fa 8 x 11?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 21677,
                "answer_text": "110",
                "is_correct": 0
            },
            {
                "answer_id": 21676,
                "answer_text": "88",
                "is_correct": 1
            },
            {
                "answer_id": 21679,
                "answer_text": "77",
                "is_correct": 0
            },
            {
                "answer_id": 21678,
                "answer_text": "99",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5529,
        "question_text": "Qual è la funzione principale del Milza?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 21617,
                "answer_text": "Produrre energia",
                "is_correct": 0
            },
            {
                "answer_id": 21619,
                "answer_text": "Controllare i muscoli",
                "is_correct": 0
            },
            {
                "answer_id": 21616,
                "answer_text": "Filtrare il sangue",
                "is_correct": 1
            },
            {
                "answer_id": 21618,
                "answer_text": "Regolare la temperatura",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5494,
        "question_text": "Quanto fa 100 ÷ 25?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 21476,
                "answer_text": "4",
                "is_correct": 1
            },
            {
                "answer_id": 21477,
                "answer_text": "110",
                "is_correct": 0
            },
            {
                "answer_id": 21479,
                "answer_text": "77",
                "is_correct": 0
            },
            {
                "answer_id": 21478,
                "answer_text": "99",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5547,
        "question_text": "Chi è l'autore de 'Furore'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 21688,
                "answer_text": "John Steinbeck",
                "is_correct": 1
            },
            {
                "answer_id": 21691,
                "answer_text": "Charles Dickens",
                "is_correct": 0
            },
            {
                "answer_id": 21689,
                "answer_text": "Oscar Wilde",
                "is_correct": 0
            },
            {
                "answer_id": 21690,
                "answer_text": "Jules Verne",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5515,
        "question_text": "Quanto fa 121 ÷ 11?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 21562,
                "answer_text": "99",
                "is_correct": 0
            },
            {
                "answer_id": 21561,
                "answer_text": "110",
                "is_correct": 0
            },
            {
                "answer_id": 21563,
                "answer_text": "77",
                "is_correct": 0
            },
            {
                "answer_id": 21560,
                "answer_text": "11",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5514,
        "question_text": "Chi è l'autore de 'La nausea'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 21559,
                "answer_text": "Charles Dickens",
                "is_correct": 0
            },
            {
                "answer_id": 21556,
                "answer_text": "Jean-Paul Sartre",
                "is_correct": 1
            },
            {
                "answer_id": 21558,
                "answer_text": "Jules Verne",
                "is_correct": 0
            },
            {
                "answer_id": 21557,
                "answer_text": "Oscar Wilde",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5523,
        "question_text": "Chi è l'autore de 'I miserabili'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 21594,
                "answer_text": "Jules Verne",
                "is_correct": 0
            },
            {
                "answer_id": 21592,
                "answer_text": "Victor Hugo",
                "is_correct": 1
            },
            {
                "answer_id": 21595,
                "answer_text": "Charles Dickens",
                "is_correct": 0
            },
            {
                "answer_id": 21593,
                "answer_text": "Oscar Wilde",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5539,
        "question_text": "Qual è la capitale del Thailandia?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 21657,
                "answer_text": "Accra",
                "is_correct": 0
            },
            {
                "answer_id": 21658,
                "answer_text": "Tunis",
                "is_correct": 0
            },
            {
                "answer_id": 21659,
                "answer_text": "Kigali",
                "is_correct": 0
            },
            {
                "answer_id": 21656,
                "answer_text": "Bangkok",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5493,
        "question_text": "Chi è l'autore de 'Il deserto dei Tartari'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 21473,
                "answer_text": "Oscar Wilde",
                "is_correct": 0
            },
            {
                "answer_id": 21472,
                "answer_text": "Dino Buzzati",
                "is_correct": 1
            },
            {
                "answer_id": 21475,
                "answer_text": "Charles Dickens",
                "is_correct": 0
            },
            {
                "answer_id": 21474,
                "answer_text": "Jules Verne",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5531,
        "question_text": "Qual è la funzione principale del Cuore?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 21626,
                "answer_text": "Regolare la temperatura",
                "is_correct": 0
            },
            {
                "answer_id": 21627,
                "answer_text": "Controllare i muscoli",
                "is_correct": 0
            },
            {
                "answer_id": 21624,
                "answer_text": "Pompare il sangue",
                "is_correct": 1
            },
            {
                "answer_id": 21625,
                "answer_text": "Produrre energia",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5748,
        "question_text": "Qual è la capitale di Slovenia?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 22495,
                "answer_text": "Skopje",
                "is_correct": 0
            },
            {
                "answer_id": 22493,
                "answer_text": "Tirana",
                "is_correct": 0
            },
            {
                "answer_id": 22494,
                "answer_text": "Praga",
                "is_correct": 0
            },
            {
                "answer_id": 22492,
                "answer_text": "Lubiana",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5749,
        "question_text": "Qual è la capitale di Macedonia del Nord?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 22499,
                "answer_text": "Skopje",
                "is_correct": 0
            },
            {
                "answer_id": 22497,
                "answer_text": "Tirana",
                "is_correct": 0
            },
            {
                "answer_id": 22496,
                "answer_text": "Skopje",
                "is_correct": 1
            },
            {
                "answer_id": 22498,
                "answer_text": "Praga",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5750,
        "question_text": "Qual è la capitale di Croazia?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 22500,
                "answer_text": "Zagabria",
                "is_correct": 1
            },
            {
                "answer_id": 22503,
                "answer_text": "Skopje",
                "is_correct": 0
            },
            {
                "answer_id": 22502,
                "answer_text": "Praga",
                "is_correct": 0
            },
            {
                "answer_id": 22501,
                "answer_text": "Tirana",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5751,
        "question_text": "Qual è la capitale di Montenegro?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 22506,
                "answer_text": "Praga",
                "is_correct": 0
            },
            {
                "answer_id": 22504,
                "answer_text": "Podgorica",
                "is_correct": 1
            },
            {
                "answer_id": 22505,
                "answer_text": "Tirana",
                "is_correct": 0
            },
            {
                "answer_id": 22507,
                "answer_text": "Skopje",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5752,
        "question_text": "Qual è la capitale di Bosnia ed Erzegovina?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 22510,
                "answer_text": "Praga",
                "is_correct": 0
            },
            {
                "answer_id": 22509,
                "answer_text": "Tirana",
                "is_correct": 0
            },
            {
                "answer_id": 22511,
                "answer_text": "Skopje",
                "is_correct": 0
            },
            {
                "answer_id": 22508,
                "answer_text": "Sarajevo",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5753,
        "question_text": "Qual è la capitale di Uzbekistan?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 22514,
                "answer_text": "Praga",
                "is_correct": 0
            },
            {
                "answer_id": 22513,
                "answer_text": "Tirana",
                "is_correct": 0
            },
            {
                "answer_id": 22515,
                "answer_text": "Skopje",
                "is_correct": 0
            },
            {
                "answer_id": 22512,
                "answer_text": "Tashkent",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5754,
        "question_text": "Qual è la capitale di Albania?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 22518,
                "answer_text": "Praga",
                "is_correct": 0
            },
            {
                "answer_id": 22519,
                "answer_text": "Skopje",
                "is_correct": 0
            },
            {
                "answer_id": 22516,
                "answer_text": "Tirana",
                "is_correct": 1
            },
            {
                "answer_id": 22517,
                "answer_text": "Tirana",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5755,
        "question_text": "Qual è la capitale di Slovacchia?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 22522,
                "answer_text": "Praga",
                "is_correct": 0
            },
            {
                "answer_id": 22523,
                "answer_text": "Skopje",
                "is_correct": 0
            },
            {
                "answer_id": 22520,
                "answer_text": "Bratislava",
                "is_correct": 1
            },
            {
                "answer_id": 22521,
                "answer_text": "Tirana",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5756,
        "question_text": "Qual è la capitale di Estonia?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 22526,
                "answer_text": "Praga",
                "is_correct": 0
            },
            {
                "answer_id": 22525,
                "answer_text": "Tirana",
                "is_correct": 0
            },
            {
                "answer_id": 22524,
                "answer_text": "Tallinn",
                "is_correct": 1
            },
            {
                "answer_id": 22527,
                "answer_text": "Skopje",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5757,
        "question_text": "Qual è la capitale di Moldavia?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 22531,
                "answer_text": "Skopje",
                "is_correct": 0
            },
            {
                "answer_id": 22528,
                "answer_text": "Chisinau",
                "is_correct": 1
            },
            {
                "answer_id": 22530,
                "answer_text": "Praga",
                "is_correct": 0
            },
            {
                "answer_id": 22529,
                "answer_text": "Tirana",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5758,
        "question_text": "Qual è la capitale di Romania?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 22535,
                "answer_text": "Skopje",
                "is_correct": 0
            },
            {
                "answer_id": 22533,
                "answer_text": "Tirana",
                "is_correct": 0
            },
            {
                "answer_id": 22534,
                "answer_text": "Praga",
                "is_correct": 0
            },
            {
                "answer_id": 22532,
                "answer_text": "Bucarest",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5759,
        "question_text": "Qual è la capitale di Bulgaria?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 22536,
                "answer_text": "Sofia",
                "is_correct": 1
            },
            {
                "answer_id": 22539,
                "answer_text": "Skopje",
                "is_correct": 0
            },
            {
                "answer_id": 22538,
                "answer_text": "Praga",
                "is_correct": 0
            },
            {
                "answer_id": 22537,
                "answer_text": "Tirana",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5760,
        "question_text": "Qual è la capitale di Armenia?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 22543,
                "answer_text": "Skopje",
                "is_correct": 0
            },
            {
                "answer_id": 22542,
                "answer_text": "Praga",
                "is_correct": 0
            },
            {
                "answer_id": 22540,
                "answer_text": "Erevan",
                "is_correct": 1
            },
            {
                "answer_id": 22541,
                "answer_text": "Tirana",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5761,
        "question_text": "Qual è la capitale di Serbia?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 22545,
                "answer_text": "Tirana",
                "is_correct": 0
            },
            {
                "answer_id": 22546,
                "answer_text": "Praga",
                "is_correct": 0
            },
            {
                "answer_id": 22547,
                "answer_text": "Skopje",
                "is_correct": 0
            },
            {
                "answer_id": 22544,
                "answer_text": "Belgrado",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5762,
        "question_text": "Qual è la capitale di Lettonia?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 22550,
                "answer_text": "Praga",
                "is_correct": 0
            },
            {
                "answer_id": 22551,
                "answer_text": "Skopje",
                "is_correct": 0
            },
            {
                "answer_id": 22549,
                "answer_text": "Tirana",
                "is_correct": 0
            },
            {
                "answer_id": 22548,
                "answer_text": "Riga",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5763,
        "question_text": "Qual è la capitale di Azerbaigian?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 22554,
                "answer_text": "Praga",
                "is_correct": 0
            },
            {
                "answer_id": 22552,
                "answer_text": "Baku",
                "is_correct": 1
            },
            {
                "answer_id": 22553,
                "answer_text": "Tirana",
                "is_correct": 0
            },
            {
                "answer_id": 22555,
                "answer_text": "Skopje",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5764,
        "question_text": "Qual è la capitale di Kazakistan?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 22558,
                "answer_text": "Praga",
                "is_correct": 0
            },
            {
                "answer_id": 22557,
                "answer_text": "Tirana",
                "is_correct": 0
            },
            {
                "answer_id": 22559,
                "answer_text": "Skopje",
                "is_correct": 0
            },
            {
                "answer_id": 22556,
                "answer_text": "Astana",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5765,
        "question_text": "Qual è la capitale di Georgia?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 22561,
                "answer_text": "Tirana",
                "is_correct": 0
            },
            {
                "answer_id": 22560,
                "answer_text": "Tbilisi",
                "is_correct": 1
            },
            {
                "answer_id": 22562,
                "answer_text": "Praga",
                "is_correct": 0
            },
            {
                "answer_id": 22563,
                "answer_text": "Skopje",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5766,
        "question_text": "Qual è la capitale di Turkmenistan?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 22567,
                "answer_text": "Skopje",
                "is_correct": 0
            },
            {
                "answer_id": 22565,
                "answer_text": "Tirana",
                "is_correct": 0
            },
            {
                "answer_id": 22564,
                "answer_text": "Ashgabat",
                "is_correct": 1
            },
            {
                "answer_id": 22566,
                "answer_text": "Praga",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5767,
        "question_text": "Qual è la capitale di Lituania?",
        "category": "Geografia",
        "answers": [
            {
                "answer_id": 22569,
                "answer_text": "Tirana",
                "is_correct": 0
            },
            {
                "answer_id": 22568,
                "answer_text": "Vilnius",
                "is_correct": 1
            },
            {
                "answer_id": 22570,
                "answer_text": "Praga",
                "is_correct": 0
            },
            {
                "answer_id": 22571,
                "answer_text": "Skopje",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5768,
        "question_text": "In che anno è avvenuto: Trattato di Versailles?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 22573,
                "answer_text": "1600",
                "is_correct": 0
            },
            {
                "answer_id": 22574,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 22575,
                "answer_text": "2000",
                "is_correct": 0
            },
            {
                "answer_id": 22572,
                "answer_text": "1919",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5769,
        "question_text": "In che anno è avvenuto: Attacco alle Torri Gemelle?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 22579,
                "answer_text": "2000",
                "is_correct": 0
            },
            {
                "answer_id": 22578,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 22576,
                "answer_text": "2001",
                "is_correct": 1
            },
            {
                "answer_id": 22577,
                "answer_text": "1600",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5770,
        "question_text": "In che anno è avvenuto: Fine Apartheid?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 22580,
                "answer_text": "1994",
                "is_correct": 1
            },
            {
                "answer_id": 22583,
                "answer_text": "2000",
                "is_correct": 0
            },
            {
                "answer_id": 22581,
                "answer_text": "1600",
                "is_correct": 0
            },
            {
                "answer_id": 22582,
                "answer_text": "1800",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5771,
        "question_text": "In che anno è avvenuto: Guerra dei Sei Giorni?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 22587,
                "answer_text": "2000",
                "is_correct": 0
            },
            {
                "answer_id": 22584,
                "answer_text": "1967",
                "is_correct": 1
            },
            {
                "answer_id": 22585,
                "answer_text": "1600",
                "is_correct": 0
            },
            {
                "answer_id": 22586,
                "answer_text": "1800",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5772,
        "question_text": "In che anno è avvenuto: Battaglia di Lepanto?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 22590,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 22589,
                "answer_text": "1600",
                "is_correct": 0
            },
            {
                "answer_id": 22588,
                "answer_text": "1571",
                "is_correct": 1
            },
            {
                "answer_id": 22591,
                "answer_text": "2000",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5773,
        "question_text": "In che anno è avvenuto: Elezione di Papa Francesco?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 22593,
                "answer_text": "1600",
                "is_correct": 0
            },
            {
                "answer_id": 22595,
                "answer_text": "2000",
                "is_correct": 0
            },
            {
                "answer_id": 22592,
                "answer_text": "2013",
                "is_correct": 1
            },
            {
                "answer_id": 22594,
                "answer_text": "1800",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5774,
        "question_text": "In che anno è avvenuto: Costituzione Italiana?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 22599,
                "answer_text": "2000",
                "is_correct": 0
            },
            {
                "answer_id": 22597,
                "answer_text": "1600",
                "is_correct": 0
            },
            {
                "answer_id": 22596,
                "answer_text": "1948",
                "is_correct": 1
            },
            {
                "answer_id": 22598,
                "answer_text": "1800",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5775,
        "question_text": "In che anno è avvenuto: Marcia su Roma?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 22603,
                "answer_text": "2000",
                "is_correct": 0
            },
            {
                "answer_id": 22601,
                "answer_text": "1600",
                "is_correct": 0
            },
            {
                "answer_id": 22600,
                "answer_text": "1922",
                "is_correct": 1
            },
            {
                "answer_id": 22602,
                "answer_text": "1800",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5776,
        "question_text": "In che anno è avvenuto: Trattato di Parigi?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 22606,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 22604,
                "answer_text": "1947",
                "is_correct": 1
            },
            {
                "answer_id": 22605,
                "answer_text": "1600",
                "is_correct": 0
            },
            {
                "answer_id": 22607,
                "answer_text": "2000",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5777,
        "question_text": "In che anno è avvenuto: Scoperta dell'America?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 22611,
                "answer_text": "2000",
                "is_correct": 0
            },
            {
                "answer_id": 22609,
                "answer_text": "1600",
                "is_correct": 0
            },
            {
                "answer_id": 22608,
                "answer_text": "1492",
                "is_correct": 1
            },
            {
                "answer_id": 22610,
                "answer_text": "1800",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5778,
        "question_text": "In che anno è avvenuto: Fondazione di Roma?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 22615,
                "answer_text": "2000",
                "is_correct": 0
            },
            {
                "answer_id": 22612,
                "answer_text": "753 a.C.",
                "is_correct": 1
            },
            {
                "answer_id": 22613,
                "answer_text": "1600",
                "is_correct": 0
            },
            {
                "answer_id": 22614,
                "answer_text": "1800",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5779,
        "question_text": "In che anno è avvenuto: Inizio Guerra di Secessione USA?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 22616,
                "answer_text": "1861",
                "is_correct": 1
            },
            {
                "answer_id": 22617,
                "answer_text": "1600",
                "is_correct": 0
            },
            {
                "answer_id": 22618,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 22619,
                "answer_text": "2000",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5780,
        "question_text": "In che anno è avvenuto: Sbarco in Normandia?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 22623,
                "answer_text": "2000",
                "is_correct": 0
            },
            {
                "answer_id": 22621,
                "answer_text": "1600",
                "is_correct": 0
            },
            {
                "answer_id": 22620,
                "answer_text": "1944",
                "is_correct": 1
            },
            {
                "answer_id": 22622,
                "answer_text": "1800",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5781,
        "question_text": "In che anno è avvenuto: Fine Impero Bizantino?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 22625,
                "answer_text": "1600",
                "is_correct": 0
            },
            {
                "answer_id": 22627,
                "answer_text": "2000",
                "is_correct": 0
            },
            {
                "answer_id": 22624,
                "answer_text": "1453",
                "is_correct": 1
            },
            {
                "answer_id": 22626,
                "answer_text": "1800",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5782,
        "question_text": "In che anno è avvenuto: Leggi razziali in Italia?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 22630,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 22628,
                "answer_text": "1938",
                "is_correct": 1
            },
            {
                "answer_id": 22631,
                "answer_text": "2000",
                "is_correct": 0
            },
            {
                "answer_id": 22629,
                "answer_text": "1600",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5783,
        "question_text": "In che anno è avvenuto: Unificazione italiana?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 22633,
                "answer_text": "1600",
                "is_correct": 0
            },
            {
                "answer_id": 22634,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 22632,
                "answer_text": "1861",
                "is_correct": 1
            },
            {
                "answer_id": 22635,
                "answer_text": "2000",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5784,
        "question_text": "In che anno è avvenuto: Armistizio dell'8 settembre?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 22637,
                "answer_text": "1600",
                "is_correct": 0
            },
            {
                "answer_id": 22638,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 22636,
                "answer_text": "1943",
                "is_correct": 1
            },
            {
                "answer_id": 22639,
                "answer_text": "2000",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5785,
        "question_text": "In che anno è avvenuto: Crisi petrolifera?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 22643,
                "answer_text": "2000",
                "is_correct": 0
            },
            {
                "answer_id": 22640,
                "answer_text": "1973",
                "is_correct": 1
            },
            {
                "answer_id": 22641,
                "answer_text": "1600",
                "is_correct": 0
            },
            {
                "answer_id": 22642,
                "answer_text": "1800",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5786,
        "question_text": "In che anno è avvenuto: Fondazione dell'UE?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 22646,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 22644,
                "answer_text": "1993",
                "is_correct": 1
            },
            {
                "answer_id": 22645,
                "answer_text": "1600",
                "is_correct": 0
            },
            {
                "answer_id": 22647,
                "answer_text": "2000",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5787,
        "question_text": "In che anno è avvenuto: Strage di Capaci?",
        "category": "Storia",
        "answers": [
            {
                "answer_id": 22650,
                "answer_text": "1800",
                "is_correct": 0
            },
            {
                "answer_id": 22651,
                "answer_text": "2000",
                "is_correct": 0
            },
            {
                "answer_id": 22648,
                "answer_text": "1992",
                "is_correct": 1
            },
            {
                "answer_id": 22649,
                "answer_text": "1600",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5788,
        "question_text": "A cosa serve il Amperometro?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 22655,
                "answer_text": "Produrre calore",
                "is_correct": 0
            },
            {
                "answer_id": 22654,
                "answer_text": "Generare corrente",
                "is_correct": 0
            },
            {
                "answer_id": 22653,
                "answer_text": "Misurare il tempo",
                "is_correct": 0
            },
            {
                "answer_id": 22652,
                "answer_text": "Misurare la corrente",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5789,
        "question_text": "A cosa serve il Altimetro?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 22659,
                "answer_text": "Produrre calore",
                "is_correct": 0
            },
            {
                "answer_id": 22658,
                "answer_text": "Generare corrente",
                "is_correct": 0
            },
            {
                "answer_id": 22656,
                "answer_text": "Misurare l'altitudine",
                "is_correct": 1
            },
            {
                "answer_id": 22657,
                "answer_text": "Misurare il tempo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5790,
        "question_text": "A cosa serve il Pulsossimetro?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 22661,
                "answer_text": "Misurare il tempo",
                "is_correct": 0
            },
            {
                "answer_id": 22660,
                "answer_text": "Misurare la saturazione",
                "is_correct": 1
            },
            {
                "answer_id": 22663,
                "answer_text": "Produrre calore",
                "is_correct": 0
            },
            {
                "answer_id": 22662,
                "answer_text": "Generare corrente",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5791,
        "question_text": "A cosa serve il Voltmetro?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 22666,
                "answer_text": "Generare corrente",
                "is_correct": 0
            },
            {
                "answer_id": 22664,
                "answer_text": "Misurare la tensione",
                "is_correct": 1
            },
            {
                "answer_id": 22667,
                "answer_text": "Produrre calore",
                "is_correct": 0
            },
            {
                "answer_id": 22665,
                "answer_text": "Misurare il tempo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5792,
        "question_text": "A cosa serve il Radiometro?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 22671,
                "answer_text": "Produrre calore",
                "is_correct": 0
            },
            {
                "answer_id": 22668,
                "answer_text": "Misurare la radiazione",
                "is_correct": 1
            },
            {
                "answer_id": 22670,
                "answer_text": "Generare corrente",
                "is_correct": 0
            },
            {
                "answer_id": 22669,
                "answer_text": "Misurare il tempo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5793,
        "question_text": "A cosa serve il Tachimetro?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 22672,
                "answer_text": "Misurare la velocità",
                "is_correct": 1
            },
            {
                "answer_id": 22675,
                "answer_text": "Produrre calore",
                "is_correct": 0
            },
            {
                "answer_id": 22674,
                "answer_text": "Generare corrente",
                "is_correct": 0
            },
            {
                "answer_id": 22673,
                "answer_text": "Misurare il tempo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5794,
        "question_text": "A cosa serve il Contatore Geiger?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 22678,
                "answer_text": "Generare corrente",
                "is_correct": 0
            },
            {
                "answer_id": 22679,
                "answer_text": "Produrre calore",
                "is_correct": 0
            },
            {
                "answer_id": 22677,
                "answer_text": "Misurare il tempo",
                "is_correct": 0
            },
            {
                "answer_id": 22676,
                "answer_text": "Misurare la radioattività",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5795,
        "question_text": "A cosa serve il Termometro?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 22682,
                "answer_text": "Generare corrente",
                "is_correct": 0
            },
            {
                "answer_id": 22681,
                "answer_text": "Misurare il tempo",
                "is_correct": 0
            },
            {
                "answer_id": 22683,
                "answer_text": "Produrre calore",
                "is_correct": 0
            },
            {
                "answer_id": 22680,
                "answer_text": "Misurare la temperatura",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5796,
        "question_text": "A cosa serve il Sismografo?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 22684,
                "answer_text": "Registrare i terremoti",
                "is_correct": 1
            },
            {
                "answer_id": 22685,
                "answer_text": "Misurare il tempo",
                "is_correct": 0
            },
            {
                "answer_id": 22686,
                "answer_text": "Generare corrente",
                "is_correct": 0
            },
            {
                "answer_id": 22687,
                "answer_text": "Produrre calore",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5797,
        "question_text": "A cosa serve il Anemometro?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 22688,
                "answer_text": "Misurare la velocità del vento",
                "is_correct": 1
            },
            {
                "answer_id": 22691,
                "answer_text": "Produrre calore",
                "is_correct": 0
            },
            {
                "answer_id": 22690,
                "answer_text": "Generare corrente",
                "is_correct": 0
            },
            {
                "answer_id": 22689,
                "answer_text": "Misurare il tempo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5798,
        "question_text": "A cosa serve il Spettroscopio?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 22694,
                "answer_text": "Generare corrente",
                "is_correct": 0
            },
            {
                "answer_id": 22692,
                "answer_text": "Analizzare la luce",
                "is_correct": 1
            },
            {
                "answer_id": 22695,
                "answer_text": "Produrre calore",
                "is_correct": 0
            },
            {
                "answer_id": 22693,
                "answer_text": "Misurare il tempo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5799,
        "question_text": "A cosa serve il Telescopio?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 22698,
                "answer_text": "Generare corrente",
                "is_correct": 0
            },
            {
                "answer_id": 22696,
                "answer_text": "Osservare i corpi celesti",
                "is_correct": 1
            },
            {
                "answer_id": 22697,
                "answer_text": "Misurare il tempo",
                "is_correct": 0
            },
            {
                "answer_id": 22699,
                "answer_text": "Produrre calore",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5800,
        "question_text": "A cosa serve il Microscopio?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 22702,
                "answer_text": "Generare corrente",
                "is_correct": 0
            },
            {
                "answer_id": 22703,
                "answer_text": "Produrre calore",
                "is_correct": 0
            },
            {
                "answer_id": 22700,
                "answer_text": "Ingrandire oggetti piccoli",
                "is_correct": 1
            },
            {
                "answer_id": 22701,
                "answer_text": "Misurare il tempo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5801,
        "question_text": "A cosa serve il Barometro?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 22706,
                "answer_text": "Generare corrente",
                "is_correct": 0
            },
            {
                "answer_id": 22704,
                "answer_text": "Misurare la pressione atmosferica",
                "is_correct": 1
            },
            {
                "answer_id": 22705,
                "answer_text": "Misurare il tempo",
                "is_correct": 0
            },
            {
                "answer_id": 22707,
                "answer_text": "Produrre calore",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5802,
        "question_text": "A cosa serve il Igrometro?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 22711,
                "answer_text": "Produrre calore",
                "is_correct": 0
            },
            {
                "answer_id": 22710,
                "answer_text": "Generare corrente",
                "is_correct": 0
            },
            {
                "answer_id": 22709,
                "answer_text": "Misurare il tempo",
                "is_correct": 0
            },
            {
                "answer_id": 22708,
                "answer_text": "Misurare l'umidità",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5803,
        "question_text": "A cosa serve il Contagiri?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 22713,
                "answer_text": "Misurare il tempo",
                "is_correct": 0
            },
            {
                "answer_id": 22712,
                "answer_text": "Misurare i giri al minuto",
                "is_correct": 1
            },
            {
                "answer_id": 22715,
                "answer_text": "Produrre calore",
                "is_correct": 0
            },
            {
                "answer_id": 22714,
                "answer_text": "Generare corrente",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5804,
        "question_text": "A cosa serve il Accelerometro?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 22719,
                "answer_text": "Produrre calore",
                "is_correct": 0
            },
            {
                "answer_id": 22716,
                "answer_text": "Misurare l'accelerazione",
                "is_correct": 1
            },
            {
                "answer_id": 22717,
                "answer_text": "Misurare il tempo",
                "is_correct": 0
            },
            {
                "answer_id": 22718,
                "answer_text": "Generare corrente",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5805,
        "question_text": "A cosa serve il Ohmmetro?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 22722,
                "answer_text": "Generare corrente",
                "is_correct": 0
            },
            {
                "answer_id": 22723,
                "answer_text": "Produrre calore",
                "is_correct": 0
            },
            {
                "answer_id": 22721,
                "answer_text": "Misurare il tempo",
                "is_correct": 0
            },
            {
                "answer_id": 22720,
                "answer_text": "Misurare la resistenza",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5806,
        "question_text": "A cosa serve il Fonendoscopio?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 22726,
                "answer_text": "Generare corrente",
                "is_correct": 0
            },
            {
                "answer_id": 22727,
                "answer_text": "Produrre calore",
                "is_correct": 0
            },
            {
                "answer_id": 22725,
                "answer_text": "Misurare il tempo",
                "is_correct": 0
            },
            {
                "answer_id": 22724,
                "answer_text": "Ascoltare i battiti cardiaci",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5807,
        "question_text": "A cosa serve il Bilancia?",
        "category": "Scienza",
        "answers": [
            {
                "answer_id": 22731,
                "answer_text": "Produrre calore",
                "is_correct": 0
            },
            {
                "answer_id": 22729,
                "answer_text": "Misurare il tempo",
                "is_correct": 0
            },
            {
                "answer_id": 22728,
                "answer_text": "Misurare la massa",
                "is_correct": 1
            },
            {
                "answer_id": 22730,
                "answer_text": "Generare corrente",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5808,
        "question_text": "Chi ha scritto 'La Storia'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 22732,
                "answer_text": "Elsa Morante",
                "is_correct": 1
            },
            {
                "answer_id": 22735,
                "answer_text": "Alberto Moravia",
                "is_correct": 0
            },
            {
                "answer_id": 22734,
                "answer_text": "Dacia Maraini",
                "is_correct": 0
            },
            {
                "answer_id": 22733,
                "answer_text": "Umberto Eco",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5809,
        "question_text": "Chi ha scritto 'La luna e i falò'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 22739,
                "answer_text": "Alberto Moravia",
                "is_correct": 0
            },
            {
                "answer_id": 22737,
                "answer_text": "Umberto Eco",
                "is_correct": 0
            },
            {
                "answer_id": 22736,
                "answer_text": "Cesare Pavese",
                "is_correct": 1
            },
            {
                "answer_id": 22738,
                "answer_text": "Dacia Maraini",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5811,
        "question_text": "Chi ha scritto 'Il barone rampante'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 22747,
                "answer_text": "Alberto Moravia",
                "is_correct": 0
            },
            {
                "answer_id": 22745,
                "answer_text": "Umberto Eco",
                "is_correct": 0
            },
            {
                "answer_id": 22746,
                "answer_text": "Dacia Maraini",
                "is_correct": 0
            },
            {
                "answer_id": 22744,
                "answer_text": "Italo Calvino",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5812,
        "question_text": "Chi ha scritto 'La solitudine dei numeri primi'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 22751,
                "answer_text": "Alberto Moravia",
                "is_correct": 0
            },
            {
                "answer_id": 22749,
                "answer_text": "Umberto Eco",
                "is_correct": 0
            },
            {
                "answer_id": 22748,
                "answer_text": "Paolo Giordano",
                "is_correct": 1
            },
            {
                "answer_id": 22750,
                "answer_text": "Dacia Maraini",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5813,
        "question_text": "Chi ha scritto 'Il giorno della civetta'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 22752,
                "answer_text": "Leonardo Sciascia",
                "is_correct": 1
            },
            {
                "answer_id": 22755,
                "answer_text": "Alberto Moravia",
                "is_correct": 0
            },
            {
                "answer_id": 22753,
                "answer_text": "Umberto Eco",
                "is_correct": 0
            },
            {
                "answer_id": 22754,
                "answer_text": "Dacia Maraini",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5814,
        "question_text": "Chi ha scritto 'Cristo si è fermato a Eboli'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 22758,
                "answer_text": "Dacia Maraini",
                "is_correct": 0
            },
            {
                "answer_id": 22757,
                "answer_text": "Umberto Eco",
                "is_correct": 0
            },
            {
                "answer_id": 22756,
                "answer_text": "Carlo Levi",
                "is_correct": 1
            },
            {
                "answer_id": 22759,
                "answer_text": "Alberto Moravia",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5815,
        "question_text": "Chi ha scritto 'Se questo è un uomo'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 22763,
                "answer_text": "Alberto Moravia",
                "is_correct": 0
            },
            {
                "answer_id": 22762,
                "answer_text": "Dacia Maraini",
                "is_correct": 0
            },
            {
                "answer_id": 22761,
                "answer_text": "Umberto Eco",
                "is_correct": 0
            },
            {
                "answer_id": 22760,
                "answer_text": "Primo Levi",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5816,
        "question_text": "Chi ha scritto 'La tregua'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 22765,
                "answer_text": "Umberto Eco",
                "is_correct": 0
            },
            {
                "answer_id": 22766,
                "answer_text": "Dacia Maraini",
                "is_correct": 0
            },
            {
                "answer_id": 22764,
                "answer_text": "Primo Levi",
                "is_correct": 1
            },
            {
                "answer_id": 22767,
                "answer_text": "Alberto Moravia",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5817,
        "question_text": "Chi ha scritto 'Lessico famigliare'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 22771,
                "answer_text": "Alberto Moravia",
                "is_correct": 0
            },
            {
                "answer_id": 22769,
                "answer_text": "Umberto Eco",
                "is_correct": 0
            },
            {
                "answer_id": 22770,
                "answer_text": "Dacia Maraini",
                "is_correct": 0
            },
            {
                "answer_id": 22768,
                "answer_text": "Natalia Ginzburg",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5818,
        "question_text": "Chi ha scritto 'Il sentiero dei nidi di ragno'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 22772,
                "answer_text": "Italo Calvino",
                "is_correct": 1
            },
            {
                "answer_id": 22773,
                "answer_text": "Umberto Eco",
                "is_correct": 0
            },
            {
                "answer_id": 22775,
                "answer_text": "Alberto Moravia",
                "is_correct": 0
            },
            {
                "answer_id": 22774,
                "answer_text": "Dacia Maraini",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5819,
        "question_text": "Chi ha scritto 'Il sistema periodico'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 22778,
                "answer_text": "Dacia Maraini",
                "is_correct": 0
            },
            {
                "answer_id": 22776,
                "answer_text": "Primo Levi",
                "is_correct": 1
            },
            {
                "answer_id": 22777,
                "answer_text": "Umberto Eco",
                "is_correct": 0
            },
            {
                "answer_id": 22779,
                "answer_text": "Alberto Moravia",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5821,
        "question_text": "Chi ha scritto 'Il visconte dimezzato'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 22785,
                "answer_text": "Umberto Eco",
                "is_correct": 0
            },
            {
                "answer_id": 22787,
                "answer_text": "Alberto Moravia",
                "is_correct": 0
            },
            {
                "answer_id": 22786,
                "answer_text": "Dacia Maraini",
                "is_correct": 0
            },
            {
                "answer_id": 22784,
                "answer_text": "Italo Calvino",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5822,
        "question_text": "Chi ha scritto 'Il giardino dei Finzi-Contini'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 22791,
                "answer_text": "Alberto Moravia",
                "is_correct": 0
            },
            {
                "answer_id": 22788,
                "answer_text": "Giorgio Bassani",
                "is_correct": 1
            },
            {
                "answer_id": 22790,
                "answer_text": "Dacia Maraini",
                "is_correct": 0
            },
            {
                "answer_id": 22789,
                "answer_text": "Umberto Eco",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5823,
        "question_text": "Chi ha scritto 'Il Gattopardo'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 22793,
                "answer_text": "Umberto Eco",
                "is_correct": 0
            },
            {
                "answer_id": 22795,
                "answer_text": "Alberto Moravia",
                "is_correct": 0
            },
            {
                "answer_id": 22794,
                "answer_text": "Dacia Maraini",
                "is_correct": 0
            },
            {
                "answer_id": 22792,
                "answer_text": "Giuseppe Tomasi di Lampedusa",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5824,
        "question_text": "Chi ha scritto 'Ragazzi di vita'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 22796,
                "answer_text": "Pier Paolo Pasolini",
                "is_correct": 1
            },
            {
                "answer_id": 22797,
                "answer_text": "Umberto Eco",
                "is_correct": 0
            },
            {
                "answer_id": 22799,
                "answer_text": "Alberto Moravia",
                "is_correct": 0
            },
            {
                "answer_id": 22798,
                "answer_text": "Dacia Maraini",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5825,
        "question_text": "Chi ha scritto 'Canne al vento'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 22802,
                "answer_text": "Dacia Maraini",
                "is_correct": 0
            },
            {
                "answer_id": 22801,
                "answer_text": "Umberto Eco",
                "is_correct": 0
            },
            {
                "answer_id": 22800,
                "answer_text": "Grazia Deledda",
                "is_correct": 1
            },
            {
                "answer_id": 22803,
                "answer_text": "Alberto Moravia",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5827,
        "question_text": "Chi ha scritto 'La lunga attesa dell’angelo'",
        "category": "Letteratura",
        "answers": [
            {
                "answer_id": 22808,
                "answer_text": "Melania G. Mazzucco",
                "is_correct": 1
            },
            {
                "answer_id": 22811,
                "answer_text": "Alberto Moravia",
                "is_correct": 0
            },
            {
                "answer_id": 22810,
                "answer_text": "Dacia Maraini",
                "is_correct": 0
            },
            {
                "answer_id": 22809,
                "answer_text": "Umberto Eco",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5829,
        "question_text": "Quanto fa 19 x 2?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 22816,
                "answer_text": "38",
                "is_correct": 1
            },
            {
                "answer_id": 22818,
                "answer_text": "90",
                "is_correct": 0
            },
            {
                "answer_id": 22819,
                "answer_text": "101",
                "is_correct": 0
            },
            {
                "answer_id": 22817,
                "answer_text": "98",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5830,
        "question_text": "Quanto fa 100 - 37?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 22820,
                "answer_text": "63",
                "is_correct": 1
            },
            {
                "answer_id": 22823,
                "answer_text": "101",
                "is_correct": 0
            },
            {
                "answer_id": 22821,
                "answer_text": "98",
                "is_correct": 0
            },
            {
                "answer_id": 22822,
                "answer_text": "90",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5831,
        "question_text": "Quanto fa 72 ÷ 8?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 22826,
                "answer_text": "90",
                "is_correct": 0
            },
            {
                "answer_id": 22827,
                "answer_text": "101",
                "is_correct": 0
            },
            {
                "answer_id": 22825,
                "answer_text": "98",
                "is_correct": 0
            },
            {
                "answer_id": 22824,
                "answer_text": "9",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5832,
        "question_text": "Quanto fa 150 - 25?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 22831,
                "answer_text": "101",
                "is_correct": 0
            },
            {
                "answer_id": 22830,
                "answer_text": "90",
                "is_correct": 0
            },
            {
                "answer_id": 22828,
                "answer_text": "125",
                "is_correct": 1
            },
            {
                "answer_id": 22829,
                "answer_text": "98",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5833,
        "question_text": "Quanto fa 8 x 8?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 22835,
                "answer_text": "101",
                "is_correct": 0
            },
            {
                "answer_id": 22832,
                "answer_text": "64",
                "is_correct": 1
            },
            {
                "answer_id": 22834,
                "answer_text": "90",
                "is_correct": 0
            },
            {
                "answer_id": 22833,
                "answer_text": "98",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5834,
        "question_text": "Quanto fa 10 x 11?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 22839,
                "answer_text": "101",
                "is_correct": 0
            },
            {
                "answer_id": 22836,
                "answer_text": "110",
                "is_correct": 1
            },
            {
                "answer_id": 22838,
                "answer_text": "90",
                "is_correct": 0
            },
            {
                "answer_id": 22837,
                "answer_text": "98",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5836,
        "question_text": "Quanto fa 13 x 13?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 22844,
                "answer_text": "169",
                "is_correct": 1
            },
            {
                "answer_id": 22847,
                "answer_text": "101",
                "is_correct": 0
            },
            {
                "answer_id": 22846,
                "answer_text": "90",
                "is_correct": 0
            },
            {
                "answer_id": 22845,
                "answer_text": "98",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5837,
        "question_text": "Quanto fa 200 ÷ 4?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 22848,
                "answer_text": "50",
                "is_correct": 1
            },
            {
                "answer_id": 22849,
                "answer_text": "98",
                "is_correct": 0
            },
            {
                "answer_id": 22851,
                "answer_text": "101",
                "is_correct": 0
            },
            {
                "answer_id": 22850,
                "answer_text": "90",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5838,
        "question_text": "Quanto fa 49 + 51?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 22852,
                "answer_text": "100",
                "is_correct": 1
            },
            {
                "answer_id": 22853,
                "answer_text": "98",
                "is_correct": 0
            },
            {
                "answer_id": 22855,
                "answer_text": "101",
                "is_correct": 0
            },
            {
                "answer_id": 22854,
                "answer_text": "90",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5840,
        "question_text": "Quanto fa 81 ÷ 3?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 22862,
                "answer_text": "90",
                "is_correct": 0
            },
            {
                "answer_id": 22863,
                "answer_text": "101",
                "is_correct": 0
            },
            {
                "answer_id": 22860,
                "answer_text": "27",
                "is_correct": 1
            },
            {
                "answer_id": 22861,
                "answer_text": "98",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5841,
        "question_text": "Quanto fa 75 ÷ 5?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 22864,
                "answer_text": "15",
                "is_correct": 1
            },
            {
                "answer_id": 22865,
                "answer_text": "98",
                "is_correct": 0
            },
            {
                "answer_id": 22866,
                "answer_text": "90",
                "is_correct": 0
            },
            {
                "answer_id": 22867,
                "answer_text": "101",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5842,
        "question_text": "Quanto fa 11 x 12?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 22871,
                "answer_text": "101",
                "is_correct": 0
            },
            {
                "answer_id": 22868,
                "answer_text": "132",
                "is_correct": 1
            },
            {
                "answer_id": 22869,
                "answer_text": "98",
                "is_correct": 0
            },
            {
                "answer_id": 22870,
                "answer_text": "90",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5843,
        "question_text": "Quanto fa 20 x 5?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 22875,
                "answer_text": "101",
                "is_correct": 0
            },
            {
                "answer_id": 22874,
                "answer_text": "90",
                "is_correct": 0
            },
            {
                "answer_id": 22873,
                "answer_text": "98",
                "is_correct": 0
            },
            {
                "answer_id": 22872,
                "answer_text": "100",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5844,
        "question_text": "Quanto fa 25 + 25?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 22877,
                "answer_text": "98",
                "is_correct": 0
            },
            {
                "answer_id": 22879,
                "answer_text": "101",
                "is_correct": 0
            },
            {
                "answer_id": 22876,
                "answer_text": "50",
                "is_correct": 1
            },
            {
                "answer_id": 22878,
                "answer_text": "90",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5845,
        "question_text": "Quanto fa 12 x 11?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 22882,
                "answer_text": "90",
                "is_correct": 0
            },
            {
                "answer_id": 22883,
                "answer_text": "101",
                "is_correct": 0
            },
            {
                "answer_id": 22880,
                "answer_text": "132",
                "is_correct": 1
            },
            {
                "answer_id": 22881,
                "answer_text": "98",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5846,
        "question_text": "Quanto fa 36 + 64?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 22886,
                "answer_text": "90",
                "is_correct": 0
            },
            {
                "answer_id": 22887,
                "answer_text": "101",
                "is_correct": 0
            },
            {
                "answer_id": 22884,
                "answer_text": "100",
                "is_correct": 1
            },
            {
                "answer_id": 22885,
                "answer_text": "98",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5847,
        "question_text": "Quanto fa 7 x 4?",
        "category": "Matematica",
        "answers": [
            {
                "answer_id": 22890,
                "answer_text": "90",
                "is_correct": 0
            },
            {
                "answer_id": 22891,
                "answer_text": "101",
                "is_correct": 0
            },
            {
                "answer_id": 22889,
                "answer_text": "98",
                "is_correct": 0
            },
            {
                "answer_id": 22888,
                "answer_text": "28",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5848,
        "question_text": "In quale serie TV compare il personaggio Walter White?",
        "category": "Serie TV",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 23094,
                "answer_text": "a7003771",
                "is_correct": 0
            },
            {
                "answer_id": 23092,
                "answer_text": "Breaking Bad",
                "is_correct": 1
            },
            {
                "answer_id": 23095,
                "answer_text": "005d1cc2",
                "is_correct": 0
            },
            {
                "answer_id": 23093,
                "answer_text": "e9b2fb02",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5849,
        "question_text": "Quale serie TV è ambientata a Hawkins, Indiana?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23098,
                "answer_text": "700c1687",
                "is_correct": 0
            },
            {
                "answer_id": 23096,
                "answer_text": "Stranger Things",
                "is_correct": 1
            },
            {
                "answer_id": 23097,
                "answer_text": "abd5dd05",
                "is_correct": 0
            },
            {
                "answer_id": 23099,
                "answer_text": "7ad4e1a2",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5850,
        "question_text": "Chi interpreta il ruolo di Sherlock Holmes nella serie BBC?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23101,
                "answer_text": "0fbb7d5d",
                "is_correct": 0
            },
            {
                "answer_id": 23102,
                "answer_text": "fba75a1f",
                "is_correct": 0
            },
            {
                "answer_id": 23103,
                "answer_text": "c4cbb3b5",
                "is_correct": 0
            },
            {
                "answer_id": 23100,
                "answer_text": "Benedict Cumberbatch",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5851,
        "question_text": "In che serie troviamo il personaggio Tyrion Lannister?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23104,
                "answer_text": "Game of Thrones",
                "is_correct": 1
            },
            {
                "answer_id": 23107,
                "answer_text": "abffc5b0",
                "is_correct": 0
            },
            {
                "answer_id": 23105,
                "answer_text": "bf3b7118",
                "is_correct": 0
            },
            {
                "answer_id": 23106,
                "answer_text": "f14b0a2d",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5852,
        "question_text": "Quale serie è incentrata su un gruppo di hacker chiamati fsociety?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23111,
                "answer_text": "e6e57e01",
                "is_correct": 0
            },
            {
                "answer_id": 23108,
                "answer_text": "Mr. Robot",
                "is_correct": 1
            },
            {
                "answer_id": 23109,
                "answer_text": "41254769",
                "is_correct": 0
            },
            {
                "answer_id": 23110,
                "answer_text": "f8b31839",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5853,
        "question_text": "Chi è il protagonista di Naruto?",
        "category": "Anime",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 23113,
                "answer_text": "4d0cba15",
                "is_correct": 0
            },
            {
                "answer_id": 23112,
                "answer_text": "Naruto Uzumaki",
                "is_correct": 1
            },
            {
                "answer_id": 23115,
                "answer_text": "7eec76b4",
                "is_correct": 0
            },
            {
                "answer_id": 23114,
                "answer_text": "26d24904",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5854,
        "question_text": "In quale anime troviamo il personaggio Goku?",
        "category": "Anime",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23117,
                "answer_text": "3708564a",
                "is_correct": 0
            },
            {
                "answer_id": 23116,
                "answer_text": "Dragon Ball",
                "is_correct": 1
            },
            {
                "answer_id": 23119,
                "answer_text": "746fbb0d",
                "is_correct": 0
            },
            {
                "answer_id": 23118,
                "answer_text": "a914d299",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5855,
        "question_text": "Qual è il nome della nave dei pirati di Luffy?",
        "category": "Anime",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23121,
                "answer_text": "f8a943d9",
                "is_correct": 0
            },
            {
                "answer_id": 23123,
                "answer_text": "c67bc747",
                "is_correct": 0
            },
            {
                "answer_id": 23122,
                "answer_text": "ca09c9ff",
                "is_correct": 0
            },
            {
                "answer_id": 23120,
                "answer_text": "Thousand Sunny",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5856,
        "question_text": "Chi ha creato l’anime 'Neon Genesis Evangelion'?",
        "category": "Anime",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 23127,
                "answer_text": "fa1e07b3",
                "is_correct": 0
            },
            {
                "answer_id": 23126,
                "answer_text": "475a5df5",
                "is_correct": 0
            },
            {
                "answer_id": 23125,
                "answer_text": "ca5cf86b",
                "is_correct": 0
            },
            {
                "answer_id": 23124,
                "answer_text": "Hideaki Anno",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5857,
        "question_text": "In quale anime ci sono i titani?",
        "category": "Anime",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 23131,
                "answer_text": "fbca60b5",
                "is_correct": 0
            },
            {
                "answer_id": 23130,
                "answer_text": "6509ac6f",
                "is_correct": 0
            },
            {
                "answer_id": 23128,
                "answer_text": "Attack on Titan",
                "is_correct": 1
            },
            {
                "answer_id": 23129,
                "answer_text": "cc114aeb",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5858,
        "question_text": "Qual è l’organo che pompa il sangue?",
        "category": "Medicina",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23133,
                "answer_text": "09185732",
                "is_correct": 0
            },
            {
                "answer_id": 23135,
                "answer_text": "dbd77ca3",
                "is_correct": 0
            },
            {
                "answer_id": 23134,
                "answer_text": "61dc395a",
                "is_correct": 0
            },
            {
                "answer_id": 23132,
                "answer_text": "Cuore",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5860,
        "question_text": "Come si chiama il medico specializzato nei bambini?",
        "category": "Medicina",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 23142,
                "answer_text": "d9815fd5",
                "is_correct": 0
            },
            {
                "answer_id": 23141,
                "answer_text": "991cde2a",
                "is_correct": 0
            },
            {
                "answer_id": 23140,
                "answer_text": "Pediatra",
                "is_correct": 1
            },
            {
                "answer_id": 23143,
                "answer_text": "89f581ef",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5861,
        "question_text": "Quale vitamina è prodotta dalla pelle al sole?",
        "category": "Medicina",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 23146,
                "answer_text": "0232a613",
                "is_correct": 0
            },
            {
                "answer_id": 23145,
                "answer_text": "07b166b1",
                "is_correct": 0
            },
            {
                "answer_id": 23147,
                "answer_text": "259a76fe",
                "is_correct": 0
            },
            {
                "answer_id": 23144,
                "answer_text": "Vitamina D",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5862,
        "question_text": "Che funzione hanno i globuli rossi?",
        "category": "Medicina",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 23148,
                "answer_text": "Trasportano ossigeno",
                "is_correct": 1
            },
            {
                "answer_id": 23151,
                "answer_text": "10422796",
                "is_correct": 0
            },
            {
                "answer_id": 23149,
                "answer_text": "589b0f28",
                "is_correct": 0
            },
            {
                "answer_id": 23150,
                "answer_text": "724ee09f",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6560,
        "question_text": "Cosa significa HTML?",
        "category": "Informatica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 27140,
                "answer_text": "HyperText Markup Language",
                "is_correct": 1
            },
            {
                "answer_id": 27143,
                "answer_text": "Hard Text Modeling Language",
                "is_correct": 0
            },
            {
                "answer_id": 27141,
                "answer_text": "Hyperlink Markup Language",
                "is_correct": 0
            },
            {
                "answer_id": 27142,
                "answer_text": "Hyper Transfer Modeling Language",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5864,
        "question_text": "Che tipo di software è Windows?",
        "category": "Informatica",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 23156,
                "answer_text": "Sistema operativo",
                "is_correct": 1
            },
            {
                "answer_id": 23159,
                "answer_text": "1e55db4c",
                "is_correct": 0
            },
            {
                "answer_id": 23157,
                "answer_text": "4ad0a51e",
                "is_correct": 0
            },
            {
                "answer_id": 23158,
                "answer_text": "38de6bc6",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5866,
        "question_text": "Cos'è una CPU?",
        "category": "Informatica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23166,
                "answer_text": "12ffbf79",
                "is_correct": 0
            },
            {
                "answer_id": 23167,
                "answer_text": "5894822b",
                "is_correct": 0
            },
            {
                "answer_id": 23164,
                "answer_text": "Unità centrale di elaborazione",
                "is_correct": 1
            },
            {
                "answer_id": 23165,
                "answer_text": "4efbd45e",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5867,
        "question_text": "Cosa indica l'acronimo AI?",
        "category": "Informatica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23169,
                "answer_text": "4b917aa4",
                "is_correct": 0
            },
            {
                "answer_id": 23170,
                "answer_text": "8c741262",
                "is_correct": 0
            },
            {
                "answer_id": 23168,
                "answer_text": "Intelligenza artificiale",
                "is_correct": 1
            },
            {
                "answer_id": 23171,
                "answer_text": "984a1525",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6568,
        "question_text": "Cosa rappresenta il PIL?",
        "category": "Economia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 27174,
                "answer_text": "Profitto Industriale Lordo",
                "is_correct": 0
            },
            {
                "answer_id": 27175,
                "answer_text": "Previsione Interna Lenta",
                "is_correct": 0
            },
            {
                "answer_id": 27173,
                "answer_text": "Prodotto Internazionale Lordo",
                "is_correct": 0
            },
            {
                "answer_id": 27172,
                "answer_text": "Prodotto Interno Lordo",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5869,
        "question_text": "Che cos’è l’inflazione?",
        "category": "Economia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 23176,
                "answer_text": "Aumento generale dei prezzi",
                "is_correct": 1
            },
            {
                "answer_id": 23179,
                "answer_text": "a8cb883c",
                "is_correct": 0
            },
            {
                "answer_id": 23177,
                "answer_text": "a88ce655",
                "is_correct": 0
            },
            {
                "answer_id": 23178,
                "answer_text": "56b331b0",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5870,
        "question_text": "Chi stampa l'euro?",
        "category": "Economia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 23183,
                "answer_text": "ef58b766",
                "is_correct": 0
            },
            {
                "answer_id": 23180,
                "answer_text": "Banca Centrale Europea",
                "is_correct": 1
            },
            {
                "answer_id": 23182,
                "answer_text": "e599928e",
                "is_correct": 0
            },
            {
                "answer_id": 23181,
                "answer_text": "160fe0f1",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5871,
        "question_text": "Che cos’è una criptovaluta?",
        "category": "Economia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23185,
                "answer_text": "b021638f",
                "is_correct": 0
            },
            {
                "answer_id": 23184,
                "answer_text": "Valuta digitale",
                "is_correct": 1
            },
            {
                "answer_id": 23186,
                "answer_text": "5a26bb8e",
                "is_correct": 0
            },
            {
                "answer_id": 23187,
                "answer_text": "f8a0457a",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5872,
        "question_text": "Cosa indica la domanda in economia?",
        "category": "Economia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23190,
                "answer_text": "234707ae",
                "is_correct": 0
            },
            {
                "answer_id": 23188,
                "answer_text": "Quantità richiesta di un bene",
                "is_correct": 1
            },
            {
                "answer_id": 23189,
                "answer_text": "d708b0e5",
                "is_correct": 0
            },
            {
                "answer_id": 23191,
                "answer_text": "b5207630",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5873,
        "question_text": "Chi è il padre della psicoanalisi?",
        "category": "Psicologia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 23194,
                "answer_text": "f99091ff",
                "is_correct": 0
            },
            {
                "answer_id": 23193,
                "answer_text": "b4cd085d",
                "is_correct": 0
            },
            {
                "answer_id": 23195,
                "answer_text": "f783aa45",
                "is_correct": 0
            },
            {
                "answer_id": 23192,
                "answer_text": "Sigmund Freud",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5874,
        "question_text": "Cos’è un trauma?",
        "category": "Psicologia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 23199,
                "answer_text": "3e8ac971",
                "is_correct": 0
            },
            {
                "answer_id": 23197,
                "answer_text": "459c9c22",
                "is_correct": 0
            },
            {
                "answer_id": 23198,
                "answer_text": "9f31839e",
                "is_correct": 0
            },
            {
                "answer_id": 23196,
                "answer_text": "Esperienza psicologicamente dannosa",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5875,
        "question_text": "Cosa studia la psicologia?",
        "category": "Psicologia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 23203,
                "answer_text": "9c5596b4",
                "is_correct": 0
            },
            {
                "answer_id": 23202,
                "answer_text": "433704d6",
                "is_correct": 0
            },
            {
                "answer_id": 23201,
                "answer_text": "c24c850f",
                "is_correct": 0
            },
            {
                "answer_id": 23200,
                "answer_text": "Comportamento e mente",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5876,
        "question_text": "Cosa sono i neuroni specchio?",
        "category": "Psicologia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23204,
                "answer_text": "Neuroni dell’empatia",
                "is_correct": 1
            },
            {
                "answer_id": 23205,
                "answer_text": "0d66cde0",
                "is_correct": 0
            },
            {
                "answer_id": 23206,
                "answer_text": "83abd3d6",
                "is_correct": 0
            },
            {
                "answer_id": 23207,
                "answer_text": "90fa10c8",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5877,
        "question_text": "Qual è il test psicologico più famoso?",
        "category": "Psicologia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23209,
                "answer_text": "57ce26fb",
                "is_correct": 0
            },
            {
                "answer_id": 23211,
                "answer_text": "0932c550",
                "is_correct": 0
            },
            {
                "answer_id": 23210,
                "answer_text": "e6ee823d",
                "is_correct": 0
            },
            {
                "answer_id": 23208,
                "answer_text": "Rorschach",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5878,
        "question_text": "Chi ha scritto 'Bohemian Rhapsody'?",
        "category": "Musica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23215,
                "answer_text": "d557ee75",
                "is_correct": 0
            },
            {
                "answer_id": 23212,
                "answer_text": "Freddie Mercury",
                "is_correct": 1
            },
            {
                "answer_id": 23214,
                "answer_text": "b6a8a0e3",
                "is_correct": 0
            },
            {
                "answer_id": 23213,
                "answer_text": "59d0cca9",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5879,
        "question_text": "Chi è il 'Re del Pop'?",
        "category": "Musica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23219,
                "answer_text": "ebb8e67f",
                "is_correct": 0
            },
            {
                "answer_id": 23216,
                "answer_text": "Michael Jackson",
                "is_correct": 1
            },
            {
                "answer_id": 23218,
                "answer_text": "1586382f",
                "is_correct": 0
            },
            {
                "answer_id": 23217,
                "answer_text": "a58bce5a",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5880,
        "question_text": "Cosa indica il simbolo ♯ in musica?",
        "category": "Musica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 23223,
                "answer_text": "d1c61245",
                "is_correct": 0
            },
            {
                "answer_id": 23222,
                "answer_text": "7d7654b4",
                "is_correct": 0
            },
            {
                "answer_id": 23220,
                "answer_text": "Diesis",
                "is_correct": 1
            },
            {
                "answer_id": 23221,
                "answer_text": "c7648fdb",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5882,
        "question_text": "Quale strumento ha tasti bianchi e neri?",
        "category": "Musica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 23228,
                "answer_text": "Pianoforte",
                "is_correct": 1
            },
            {
                "answer_id": 23231,
                "answer_text": "195dc7ba",
                "is_correct": 0
            },
            {
                "answer_id": 23229,
                "answer_text": "571648b4",
                "is_correct": 0
            },
            {
                "answer_id": 23230,
                "answer_text": "503e53d6",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5884,
        "question_text": "In che museo si trova la Gioconda?",
        "category": "Arte",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 23237,
                "answer_text": "e4dbfef2",
                "is_correct": 0
            },
            {
                "answer_id": 23239,
                "answer_text": "77b985f9",
                "is_correct": 0
            },
            {
                "answer_id": 23236,
                "answer_text": "Louvre",
                "is_correct": 1
            },
            {
                "answer_id": 23238,
                "answer_text": "2983352c",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5885,
        "question_text": "Chi ha scolpito il David?",
        "category": "Arte",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 23242,
                "answer_text": "84ebefdf",
                "is_correct": 0
            },
            {
                "answer_id": 23241,
                "answer_text": "73c1fec4",
                "is_correct": 0
            },
            {
                "answer_id": 23243,
                "answer_text": "ce586c13",
                "is_correct": 0
            },
            {
                "answer_id": 23240,
                "answer_text": "Michelangelo",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5886,
        "question_text": "Che stile è 'La notte stellata'?",
        "category": "Arte",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 23246,
                "answer_text": "8cc0839b",
                "is_correct": 0
            },
            {
                "answer_id": 23245,
                "answer_text": "77132de9",
                "is_correct": 0
            },
            {
                "answer_id": 23244,
                "answer_text": "Post-impressionismo",
                "is_correct": 1
            },
            {
                "answer_id": 23247,
                "answer_text": "d79b9122",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5887,
        "question_text": "Quale pittore ha tagliato il proprio orecchio?",
        "category": "Arte",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23249,
                "answer_text": "04a37cee",
                "is_correct": 0
            },
            {
                "answer_id": 23248,
                "answer_text": "Van Gogh",
                "is_correct": 1
            },
            {
                "answer_id": 23251,
                "answer_text": "c2548c52",
                "is_correct": 0
            },
            {
                "answer_id": 23250,
                "answer_text": "0e901059",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5888,
        "question_text": "Chi ha vinto più Mondiali di calcio?",
        "category": "Sport",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 23254,
                "answer_text": "afb73b54",
                "is_correct": 0
            },
            {
                "answer_id": 23255,
                "answer_text": "eb5ac874",
                "is_correct": 0
            },
            {
                "answer_id": 23252,
                "answer_text": "Brasile",
                "is_correct": 1
            },
            {
                "answer_id": 23253,
                "answer_text": "86bac99e",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5889,
        "question_text": "Quanti giocatori in campo per squadra nel calcio?",
        "category": "Sport",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 23259,
                "answer_text": "3f77d9ec",
                "is_correct": 0
            },
            {
                "answer_id": 23258,
                "answer_text": "9bcc3f0f",
                "is_correct": 0
            },
            {
                "answer_id": 23256,
                "answer_text": "11",
                "is_correct": 1
            },
            {
                "answer_id": 23257,
                "answer_text": "18f05cf2",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5890,
        "question_text": "Chi è Usain Bolt?",
        "category": "Sport",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 23262,
                "answer_text": "63f82b7e",
                "is_correct": 0
            },
            {
                "answer_id": 23261,
                "answer_text": "beb20507",
                "is_correct": 0
            },
            {
                "answer_id": 23263,
                "answer_text": "742a52c2",
                "is_correct": 0
            },
            {
                "answer_id": 23260,
                "answer_text": "Velocista giamaicano",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5891,
        "question_text": "Dove si svolgono le Olimpiadi ogni 4 anni?",
        "category": "Sport",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 23264,
                "answer_text": "Città diverse",
                "is_correct": 1
            },
            {
                "answer_id": 23266,
                "answer_text": "5e8306ee",
                "is_correct": 0
            },
            {
                "answer_id": 23265,
                "answer_text": "1e2e45ea",
                "is_correct": 0
            },
            {
                "answer_id": 23267,
                "answer_text": "4df60cde",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5892,
        "question_text": "Qual è lo sport del Tour de France?",
        "category": "Sport",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 23268,
                "answer_text": "Ciclismo",
                "is_correct": 1
            },
            {
                "answer_id": 23269,
                "answer_text": "6b9f40c2",
                "is_correct": 0
            },
            {
                "answer_id": 23271,
                "answer_text": "a8b24afa",
                "is_correct": 0
            },
            {
                "answer_id": 23270,
                "answer_text": "074142bf",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5893,
        "question_text": "Qual è l’animale simbolo dell’Italia?",
        "category": "Cultura Generale",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23273,
                "answer_text": "03d9fe3b",
                "is_correct": 0
            },
            {
                "answer_id": 23275,
                "answer_text": "e8f73028",
                "is_correct": 0
            },
            {
                "answer_id": 23272,
                "answer_text": "Lupo",
                "is_correct": 1
            },
            {
                "answer_id": 23274,
                "answer_text": "81ac4401",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 8337,
        "question_text": "Chi ha scritto la Divina Commedia?",
        "category": "Cultura Generale",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 33049,
                "answer_text": "Petrarca",
                "is_correct": 0
            },
            {
                "answer_id": 33051,
                "answer_text": "Manzoni",
                "is_correct": 0
            },
            {
                "answer_id": 33050,
                "answer_text": "Boccaccio",
                "is_correct": 0
            },
            {
                "answer_id": 33048,
                "answer_text": "Dante Alighieri",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 5896,
        "question_text": "Quanti pianeti ha il sistema solare?",
        "category": "Cultura Generale",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23286,
                "answer_text": "d92b92f9",
                "is_correct": 0
            },
            {
                "answer_id": 23284,
                "answer_text": "8",
                "is_correct": 1
            },
            {
                "answer_id": 23287,
                "answer_text": "b762b0f6",
                "is_correct": 0
            },
            {
                "answer_id": 23285,
                "answer_text": "2405671f",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5998,
        "question_text": "In quale serie TV appare il personaggio di Eleven?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23695,
                "answer_text": "The OA",
                "is_correct": 0
            },
            {
                "answer_id": 23692,
                "answer_text": "Stranger Things",
                "is_correct": 1
            },
            {
                "answer_id": 23694,
                "answer_text": "The Umbrella Academy",
                "is_correct": 0
            },
            {
                "answer_id": 23693,
                "answer_text": "Dark",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 5999,
        "question_text": "Chi interpreta Rick Grimes in The Walking Dead?",
        "category": "Serie TV",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 23698,
                "answer_text": "Jon Bernthal",
                "is_correct": 0
            },
            {
                "answer_id": 23699,
                "answer_text": "Steven Yeun",
                "is_correct": 0
            },
            {
                "answer_id": 23697,
                "answer_text": "Norman Reedus",
                "is_correct": 0
            },
            {
                "answer_id": 23696,
                "answer_text": "Andrew Lincoln",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6000,
        "question_text": "Quale serie è ambientata ad Albuquerque, New Mexico?",
        "category": "Serie TV",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 23703,
                "answer_text": "The Sopranos",
                "is_correct": 0
            },
            {
                "answer_id": 23702,
                "answer_text": "Fargo",
                "is_correct": 0
            },
            {
                "answer_id": 23701,
                "answer_text": "Better Call Saul",
                "is_correct": 0
            },
            {
                "answer_id": 23700,
                "answer_text": "Breaking Bad",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6001,
        "question_text": "Chi è il capitano della ciurma di Cappello di Paglia?",
        "category": "Anime",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 23706,
                "answer_text": "Sanji",
                "is_correct": 0
            },
            {
                "answer_id": 23704,
                "answer_text": "Monkey D. Luffy",
                "is_correct": 1
            },
            {
                "answer_id": 23707,
                "answer_text": "Usopp",
                "is_correct": 0
            },
            {
                "answer_id": 23705,
                "answer_text": "Zoro",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6002,
        "question_text": "In Death Note, qual è il nome del dio della morte?",
        "category": "Anime",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23710,
                "answer_text": "Light",
                "is_correct": 0
            },
            {
                "answer_id": 23711,
                "answer_text": "Misa",
                "is_correct": 0
            },
            {
                "answer_id": 23708,
                "answer_text": "Ryuk",
                "is_correct": 1
            },
            {
                "answer_id": 23709,
                "answer_text": "Rem",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6003,
        "question_text": "Chi è il fratello di Itachi Uchiha?",
        "category": "Anime",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23713,
                "answer_text": "Naruto Uzumaki",
                "is_correct": 0
            },
            {
                "answer_id": 23712,
                "answer_text": "Sasuke Uchiha",
                "is_correct": 1
            },
            {
                "answer_id": 23715,
                "answer_text": "Kakashi Hatake",
                "is_correct": 0
            },
            {
                "answer_id": 23714,
                "answer_text": "Madara Uchiha",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6004,
        "question_text": "Quale organo produce l’insulina?",
        "category": "Medicina",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23718,
                "answer_text": "Rene",
                "is_correct": 0
            },
            {
                "answer_id": 23717,
                "answer_text": "Fegato",
                "is_correct": 0
            },
            {
                "answer_id": 23719,
                "answer_text": "Milza",
                "is_correct": 0
            },
            {
                "answer_id": 23716,
                "answer_text": "Pancreas",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6005,
        "question_text": "Come si chiama la cellula responsabile della coagulazione del sangue?",
        "category": "Medicina",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 23723,
                "answer_text": "Globulo bianco",
                "is_correct": 0
            },
            {
                "answer_id": 23720,
                "answer_text": "Piastrina",
                "is_correct": 1
            },
            {
                "answer_id": 23721,
                "answer_text": "Globulo rosso",
                "is_correct": 0
            },
            {
                "answer_id": 23722,
                "answer_text": "Neurone",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6006,
        "question_text": "Quale malattia è causata dal virus HIV?",
        "category": "Medicina",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 23725,
                "answer_text": "Epatite",
                "is_correct": 0
            },
            {
                "answer_id": 23724,
                "answer_text": "AIDS",
                "is_correct": 1
            },
            {
                "answer_id": 23726,
                "answer_text": "Influenza",
                "is_correct": 0
            },
            {
                "answer_id": 23727,
                "answer_text": "Polmonite",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6007,
        "question_text": "Quale linguaggio è usato per lo sviluppo web frontend?",
        "category": "Informatica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23729,
                "answer_text": "Python",
                "is_correct": 0
            },
            {
                "answer_id": 23728,
                "answer_text": "JavaScript",
                "is_correct": 1
            },
            {
                "answer_id": 23731,
                "answer_text": "C++",
                "is_correct": 0
            },
            {
                "answer_id": 23730,
                "answer_text": "Java",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6008,
        "question_text": "Cosa indica l'acronimo CPU?",
        "category": "Informatica",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 23735,
                "answer_text": "Computer Processor Unit",
                "is_correct": 0
            },
            {
                "answer_id": 23734,
                "answer_text": "Central Panel Unit",
                "is_correct": 0
            },
            {
                "answer_id": 23733,
                "answer_text": "Control Power Unit",
                "is_correct": 0
            },
            {
                "answer_id": 23732,
                "answer_text": "Central Processing Unit",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6562,
        "question_text": "Cos'è un algoritmo?",
        "category": "Informatica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 27151,
                "answer_text": "Un linguaggio di programmazione",
                "is_correct": 0
            },
            {
                "answer_id": 27150,
                "answer_text": "Un tipo di database",
                "is_correct": 0
            },
            {
                "answer_id": 27149,
                "answer_text": "Un programma di navigazione",
                "is_correct": 0
            },
            {
                "answer_id": 27148,
                "answer_text": "Sequenza di istruzioni per risolvere un problema",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6010,
        "question_text": "Che cos’è il debito pubblico?",
        "category": "Economia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23740,
                "answer_text": "Somma che lo Stato deve restituire",
                "is_correct": 1
            },
            {
                "answer_id": 23743,
                "answer_text": "Spesa per la sanità",
                "is_correct": 0
            },
            {
                "answer_id": 23741,
                "answer_text": "Importo dei salari",
                "is_correct": 0
            },
            {
                "answer_id": 23742,
                "answer_text": "Reddito delle famiglie",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6011,
        "question_text": "Cosa indica l’IVA?",
        "category": "Economia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23745,
                "answer_text": "Imposta sugli utili annuali",
                "is_correct": 0
            },
            {
                "answer_id": 23747,
                "answer_text": "Indice valutario alternativo",
                "is_correct": 0
            },
            {
                "answer_id": 23746,
                "answer_text": "Investimento variabile annuale",
                "is_correct": 0
            },
            {
                "answer_id": 23744,
                "answer_text": "Imposta sul valore aggiunto",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6012,
        "question_text": "Qual è la funzione della Banca Centrale?",
        "category": "Economia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 23750,
                "answer_text": "Stampare azioni",
                "is_correct": 0
            },
            {
                "answer_id": 23748,
                "answer_text": "Controllare la politica monetaria",
                "is_correct": 1
            },
            {
                "answer_id": 23749,
                "answer_text": "Gestire le imprese",
                "is_correct": 0
            },
            {
                "answer_id": 23751,
                "answer_text": "Investire in borsa",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6013,
        "question_text": "Cos’è l’effetto placebo?",
        "category": "Psicologia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 23753,
                "answer_text": "Reazione allergica",
                "is_correct": 0
            },
            {
                "answer_id": 23752,
                "answer_text": "Miglioramento dovuto all'aspettativa",
                "is_correct": 1
            },
            {
                "answer_id": 23755,
                "answer_text": "Effetto contrario al farmaco",
                "is_correct": 0
            },
            {
                "answer_id": 23754,
                "answer_text": "Ansia anticipatoria",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6014,
        "question_text": "Chi ha teorizzato i bisogni in una piramide?",
        "category": "Psicologia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23759,
                "answer_text": "Jung",
                "is_correct": 0
            },
            {
                "answer_id": 23756,
                "answer_text": "Maslow",
                "is_correct": 1
            },
            {
                "answer_id": 23758,
                "answer_text": "Skinner",
                "is_correct": 0
            },
            {
                "answer_id": 23757,
                "answer_text": "Freud",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6015,
        "question_text": "Cos’è un disturbo d’ansia?",
        "category": "Psicologia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 23762,
                "answer_text": "Ipersensibilità al suono",
                "is_correct": 0
            },
            {
                "answer_id": 23760,
                "answer_text": "Condizione di ansia persistente",
                "is_correct": 1
            },
            {
                "answer_id": 23761,
                "answer_text": "Perdita di memoria",
                "is_correct": 0
            },
            {
                "answer_id": 23763,
                "answer_text": "Stato di euforia",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6016,
        "question_text": "Chi ha composto il Bolero?",
        "category": "Musica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23765,
                "answer_text": "Ludwig van Beethoven",
                "is_correct": 0
            },
            {
                "answer_id": 23767,
                "answer_text": "Johann Strauss",
                "is_correct": 0
            },
            {
                "answer_id": 23764,
                "answer_text": "Maurice Ravel",
                "is_correct": 1
            },
            {
                "answer_id": 23766,
                "answer_text": "Franz Schubert",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6017,
        "question_text": "Qual è lo strumento principale in un’orchestra?",
        "category": "Musica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 23770,
                "answer_text": "Tromba",
                "is_correct": 0
            },
            {
                "answer_id": 23768,
                "answer_text": "Violino",
                "is_correct": 1
            },
            {
                "answer_id": 23771,
                "answer_text": "Flauto",
                "is_correct": 0
            },
            {
                "answer_id": 23769,
                "answer_text": "Pianoforte",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6018,
        "question_text": "Cosa rappresenta il pentagramma?",
        "category": "Musica",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 23772,
                "answer_text": "Sistema di notazione musicale",
                "is_correct": 1
            },
            {
                "answer_id": 23775,
                "answer_text": "Tecnica di canto",
                "is_correct": 0
            },
            {
                "answer_id": 23774,
                "answer_text": "Tipo di canzone",
                "is_correct": 0
            },
            {
                "answer_id": 23773,
                "answer_text": "Strumento musicale",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6019,
        "question_text": "Chi ha dipinto 'La persistenza della memoria'?",
        "category": "Arte",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 23776,
                "answer_text": "Salvador Dalí",
                "is_correct": 1
            },
            {
                "answer_id": 23777,
                "answer_text": "Pablo Picasso",
                "is_correct": 0
            },
            {
                "answer_id": 23779,
                "answer_text": "Joan Miró",
                "is_correct": 0
            },
            {
                "answer_id": 23778,
                "answer_text": "René Magritte",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6586,
        "question_text": "Cos'è un affresco?",
        "category": "Arte",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 27246,
                "answer_text": "Tecnica scultorea",
                "is_correct": 0
            },
            {
                "answer_id": 27247,
                "answer_text": "Decorazione in legno",
                "is_correct": 0
            },
            {
                "answer_id": 27245,
                "answer_text": "Tecnica su tela",
                "is_correct": 0
            },
            {
                "answer_id": 27244,
                "answer_text": "Tecnica pittorica su intonaco fresco",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6021,
        "question_text": "Chi ha scolpito 'La Pietà'?",
        "category": "Arte",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 23787,
                "answer_text": "Canova",
                "is_correct": 0
            },
            {
                "answer_id": 23785,
                "answer_text": "Donatello",
                "is_correct": 0
            },
            {
                "answer_id": 23784,
                "answer_text": "Michelangelo",
                "is_correct": 1
            },
            {
                "answer_id": 23786,
                "answer_text": "Bernini",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6022,
        "question_text": "Chi ha vinto i Mondiali 2006?",
        "category": "Sport",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23791,
                "answer_text": "Spagna",
                "is_correct": 0
            },
            {
                "answer_id": 23788,
                "answer_text": "Italia",
                "is_correct": 1
            },
            {
                "answer_id": 23790,
                "answer_text": "Germania",
                "is_correct": 0
            },
            {
                "answer_id": 23789,
                "answer_text": "Francia",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6023,
        "question_text": "Quanti punti vale una tripla nel basket?",
        "category": "Sport",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23795,
                "answer_text": "1",
                "is_correct": 0
            },
            {
                "answer_id": 23794,
                "answer_text": "4",
                "is_correct": 0
            },
            {
                "answer_id": 23793,
                "answer_text": "2",
                "is_correct": 0
            },
            {
                "answer_id": 23792,
                "answer_text": "3",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6024,
        "question_text": "In quale sport si usa la racchetta e la pallina gialla?",
        "category": "Sport",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23798,
                "answer_text": "Baseball",
                "is_correct": 0
            },
            {
                "answer_id": 23796,
                "answer_text": "Tennis",
                "is_correct": 1
            },
            {
                "answer_id": 23799,
                "answer_text": "Golf",
                "is_correct": 0
            },
            {
                "answer_id": 23797,
                "answer_text": "Ping pong",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25077,
        "question_text": "Chi ha scritto 'Il Principe'?",
        "category": "Cultura Generale",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45310,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 45311,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 45309,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 45308,
                "answer_text": "Niccolò Machiavelli",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6027,
        "question_text": "Quale metallo ha simbolo chimico Fe?",
        "category": "Cultura Generale",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 23809,
                "answer_text": "Piombo",
                "is_correct": 0
            },
            {
                "answer_id": 23811,
                "answer_text": "Zinco",
                "is_correct": 0
            },
            {
                "answer_id": 23808,
                "answer_text": "Ferro",
                "is_correct": 1
            },
            {
                "answer_id": 23810,
                "answer_text": "Rame",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6148,
        "question_text": "Chi è il protagonista di 'Dexter'?",
        "category": "Serie TV",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 24295,
                "answer_text": "Hank Moody",
                "is_correct": 0
            },
            {
                "answer_id": 24294,
                "answer_text": "Michael Scofield",
                "is_correct": 0
            },
            {
                "answer_id": 24292,
                "answer_text": "Dexter Morgan",
                "is_correct": 1
            },
            {
                "answer_id": 24293,
                "answer_text": "Walter White",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6149,
        "question_text": "In 'How I Met Your Mother', chi sposa Lily?",
        "category": "Serie TV",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 24299,
                "answer_text": "Robin",
                "is_correct": 0
            },
            {
                "answer_id": 24296,
                "answer_text": "Marshall",
                "is_correct": 1
            },
            {
                "answer_id": 24298,
                "answer_text": "Barney",
                "is_correct": 0
            },
            {
                "answer_id": 24297,
                "answer_text": "Ted",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6150,
        "question_text": "Chi è il rivale storico di Goku?",
        "category": "Anime",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 24303,
                "answer_text": "Piccolo",
                "is_correct": 0
            },
            {
                "answer_id": 24300,
                "answer_text": "Vegeta",
                "is_correct": 1
            },
            {
                "answer_id": 24302,
                "answer_text": "Gohan",
                "is_correct": 0
            },
            {
                "answer_id": 24301,
                "answer_text": "Frieza",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6151,
        "question_text": "In My Hero Academia, chi ha il potere One for All?",
        "category": "Anime",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 24307,
                "answer_text": "All Might",
                "is_correct": 0
            },
            {
                "answer_id": 24304,
                "answer_text": "Izuku Midoriya",
                "is_correct": 1
            },
            {
                "answer_id": 24306,
                "answer_text": "Shoto Todoroki",
                "is_correct": 0
            },
            {
                "answer_id": 24305,
                "answer_text": "Katsuki Bakugo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6152,
        "question_text": "Come si chiama il processo di divisione cellulare?",
        "category": "Medicina",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 24308,
                "answer_text": "Mitosi",
                "is_correct": 1
            },
            {
                "answer_id": 24309,
                "answer_text": "Meiosi",
                "is_correct": 0
            },
            {
                "answer_id": 24311,
                "answer_text": "Osmosi",
                "is_correct": 0
            },
            {
                "answer_id": 24310,
                "answer_text": "Fotosintesi",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6153,
        "question_text": "Che tipo di medico cura i denti?",
        "category": "Medicina",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 24312,
                "answer_text": "Dentista",
                "is_correct": 1
            },
            {
                "answer_id": 24313,
                "answer_text": "Cardiologo",
                "is_correct": 0
            },
            {
                "answer_id": 24315,
                "answer_text": "Dermatologo",
                "is_correct": 0
            },
            {
                "answer_id": 24314,
                "answer_text": "Ortopedico",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6154,
        "question_text": "Cosa indica HTTP?",
        "category": "Informatica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 24317,
                "answer_text": "Home Terminal Transfer Protocol",
                "is_correct": 0
            },
            {
                "answer_id": 24319,
                "answer_text": "Host Trace Transfer Protocol",
                "is_correct": 0
            },
            {
                "answer_id": 24318,
                "answer_text": "Hyper Tool Test Protocol",
                "is_correct": 0
            },
            {
                "answer_id": 24316,
                "answer_text": "HyperText Transfer Protocol",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6155,
        "question_text": "Quale estensione indica un file eseguibile su Windows?",
        "category": "Informatica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 24322,
                "answer_text": ".zip",
                "is_correct": 0
            },
            {
                "answer_id": 24323,
                "answer_text": ".png",
                "is_correct": 0
            },
            {
                "answer_id": 24321,
                "answer_text": ".txt",
                "is_correct": 0
            },
            {
                "answer_id": 24320,
                "answer_text": ".exe",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6156,
        "question_text": "Cos'è un'azione?",
        "category": "Economia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 24324,
                "answer_text": "Parte di una società",
                "is_correct": 1
            },
            {
                "answer_id": 24326,
                "answer_text": "Forma di prestito",
                "is_correct": 0
            },
            {
                "answer_id": 24325,
                "answer_text": "Tipo di valuta",
                "is_correct": 0
            },
            {
                "answer_id": 24327,
                "answer_text": "Tassa annuale",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6157,
        "question_text": "Cosa misura il tasso di disoccupazione?",
        "category": "Economia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 24328,
                "answer_text": "Persone senza lavoro",
                "is_correct": 1
            },
            {
                "answer_id": 24329,
                "answer_text": "Prezzi dei beni",
                "is_correct": 0
            },
            {
                "answer_id": 24330,
                "answer_text": "Pil totale",
                "is_correct": 0
            },
            {
                "answer_id": 24331,
                "answer_text": "Debito pubblico",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6158,
        "question_text": "Cos'è una fobia?",
        "category": "Psicologia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 24333,
                "answer_text": "Ansia lieve",
                "is_correct": 0
            },
            {
                "answer_id": 24334,
                "answer_text": "Ossessione",
                "is_correct": 0
            },
            {
                "answer_id": 24332,
                "answer_text": "Paura irrazionale",
                "is_correct": 1
            },
            {
                "answer_id": 24335,
                "answer_text": "Desiderio eccessivo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6159,
        "question_text": "Cos'è l’intelligenza emotiva?",
        "category": "Psicologia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 24336,
                "answer_text": "Capacità di gestire emozioni",
                "is_correct": 1
            },
            {
                "answer_id": 24338,
                "answer_text": "Ragionamento logico",
                "is_correct": 0
            },
            {
                "answer_id": 24339,
                "answer_text": "Calcolo rapido",
                "is_correct": 0
            },
            {
                "answer_id": 24337,
                "answer_text": "Memoria visiva",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6160,
        "question_text": "Chi è l'autore di 'Imagine'?",
        "category": "Musica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 24340,
                "answer_text": "John Lennon",
                "is_correct": 1
            },
            {
                "answer_id": 24343,
                "answer_text": "Elton John",
                "is_correct": 0
            },
            {
                "answer_id": 24341,
                "answer_text": "Paul McCartney",
                "is_correct": 0
            },
            {
                "answer_id": 24342,
                "answer_text": "Bob Dylan",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6161,
        "question_text": "Qual è il simbolo del bemolle?",
        "category": "Musica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 24344,
                "answer_text": "♭",
                "is_correct": 1
            },
            {
                "answer_id": 24345,
                "answer_text": "♯",
                "is_correct": 0
            },
            {
                "answer_id": 24347,
                "answer_text": "∑",
                "is_correct": 0
            },
            {
                "answer_id": 24346,
                "answer_text": "♮",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6162,
        "question_text": "Quale artista è famoso per le lattine di zuppa?",
        "category": "Arte",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 24349,
                "answer_text": "Roy Lichtenstein",
                "is_correct": 0
            },
            {
                "answer_id": 24350,
                "answer_text": "Keith Haring",
                "is_correct": 0
            },
            {
                "answer_id": 24351,
                "answer_text": "Jean-Michel Basquiat",
                "is_correct": 0
            },
            {
                "answer_id": 24348,
                "answer_text": "Andy Warhol",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6588,
        "question_text": "Chi ha vinto il mondiale di calcio 2018?",
        "category": "Sport",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 27252,
                "answer_text": "Francia",
                "is_correct": 1
            },
            {
                "answer_id": 27254,
                "answer_text": "Spagna",
                "is_correct": 0
            },
            {
                "answer_id": 27255,
                "answer_text": "Inghilterra",
                "is_correct": 0
            },
            {
                "answer_id": 27253,
                "answer_text": "Croazia",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6165,
        "question_text": "Quanti set si giocano nel tennis maschile al meglio?",
        "category": "Sport",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 24362,
                "answer_text": "2",
                "is_correct": 0
            },
            {
                "answer_id": 24361,
                "answer_text": "3",
                "is_correct": 0
            },
            {
                "answer_id": 24360,
                "answer_text": "5",
                "is_correct": 1
            },
            {
                "answer_id": 24363,
                "answer_text": "4",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 8338,
        "question_text": "Chi è il protagonista di Demon Slayer?",
        "category": "Anime",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 33053,
                "answer_text": "Zenitsu",
                "is_correct": 0
            },
            {
                "answer_id": 33052,
                "answer_text": "Tanjiro Kamado",
                "is_correct": 1
            },
            {
                "answer_id": 33055,
                "answer_text": "Nezuko",
                "is_correct": 0
            },
            {
                "answer_id": 33054,
                "answer_text": "Inosuke",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6249,
        "question_text": "Chi è il padre di Gon in Hunter x Hunter?",
        "category": "Anime",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 24697,
                "answer_text": "Leorio",
                "is_correct": 0
            },
            {
                "answer_id": 24696,
                "answer_text": "Ging Freecss",
                "is_correct": 1
            },
            {
                "answer_id": 24699,
                "answer_text": "Killua",
                "is_correct": 0
            },
            {
                "answer_id": 24698,
                "answer_text": "Hisoka",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6250,
        "question_text": "Come si chiama il quirk di Shoto Todoroki?",
        "category": "Anime",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 24701,
                "answer_text": "One for All",
                "is_correct": 0
            },
            {
                "answer_id": 24702,
                "answer_text": "Explosion",
                "is_correct": 0
            },
            {
                "answer_id": 24703,
                "answer_text": "Hardening",
                "is_correct": 0
            },
            {
                "answer_id": 24700,
                "answer_text": "Fuoco e Ghiaccio",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6251,
        "question_text": "Quale potere usa Eren in Attack on Titan?",
        "category": "Anime",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 24707,
                "answer_text": "Gigante Colossale",
                "is_correct": 0
            },
            {
                "answer_id": 24704,
                "answer_text": "Gigante Fondatore",
                "is_correct": 1
            },
            {
                "answer_id": 24705,
                "answer_text": "Gigante Corazzato",
                "is_correct": 0
            },
            {
                "answer_id": 24706,
                "answer_text": "Gigante Bestia",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6252,
        "question_text": "Chi è l'antagonista principale di Death Note?",
        "category": "Anime",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 24708,
                "answer_text": "Light Yagami",
                "is_correct": 1
            },
            {
                "answer_id": 24709,
                "answer_text": "L",
                "is_correct": 0
            },
            {
                "answer_id": 24710,
                "answer_text": "Ryuk",
                "is_correct": 0
            },
            {
                "answer_id": 24711,
                "answer_text": "Mello",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6253,
        "question_text": "Chi è il creatore di Black Mirror?",
        "category": "Serie TV",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 24713,
                "answer_text": "Vince Gilligan",
                "is_correct": 0
            },
            {
                "answer_id": 24714,
                "answer_text": "David Benioff",
                "is_correct": 0
            },
            {
                "answer_id": 24715,
                "answer_text": "Ryan Murphy",
                "is_correct": 0
            },
            {
                "answer_id": 24712,
                "answer_text": "Charlie Brooker",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 8345,
        "question_text": "Dove lavora Sheldon in The Big Bang Theory?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 33082,
                "answer_text": "MIT",
                "is_correct": 0
            },
            {
                "answer_id": 33080,
                "answer_text": "Caltech",
                "is_correct": 1
            },
            {
                "answer_id": 33081,
                "answer_text": "NASA",
                "is_correct": 0
            },
            {
                "answer_id": 33083,
                "answer_text": "Google",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6255,
        "question_text": "Chi è il fratello di Tony in The Sopranos?",
        "category": "Serie TV",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 24722,
                "answer_text": "Christopher",
                "is_correct": 0
            },
            {
                "answer_id": 24723,
                "answer_text": "Carmela",
                "is_correct": 0
            },
            {
                "answer_id": 24721,
                "answer_text": "Paulie",
                "is_correct": 0
            },
            {
                "answer_id": 24720,
                "answer_text": "Janice",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6256,
        "question_text": "Quale serie racconta la vita della Regina Elisabetta II?",
        "category": "Serie TV",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 24726,
                "answer_text": "Reign",
                "is_correct": 0
            },
            {
                "answer_id": 24725,
                "answer_text": "Victoria",
                "is_correct": 0
            },
            {
                "answer_id": 24727,
                "answer_text": "Downton Abbey",
                "is_correct": 0
            },
            {
                "answer_id": 24724,
                "answer_text": "The Crown",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6257,
        "question_text": "In quale serie troviamo l'agenzia Dunder Mifflin?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 24729,
                "answer_text": "Parks and Recreation",
                "is_correct": 0
            },
            {
                "answer_id": 24731,
                "answer_text": "Community",
                "is_correct": 0
            },
            {
                "answer_id": 24730,
                "answer_text": "Brooklyn Nine-Nine",
                "is_correct": 0
            },
            {
                "answer_id": 24728,
                "answer_text": "The Office",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6258,
        "question_text": "Quale linguaggio è noto per lo sviluppo di app Android?",
        "category": "Informatica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 24735,
                "answer_text": "PHP",
                "is_correct": 0
            },
            {
                "answer_id": 24733,
                "answer_text": "Swift",
                "is_correct": 0
            },
            {
                "answer_id": 24732,
                "answer_text": "Kotlin",
                "is_correct": 1
            },
            {
                "answer_id": 24734,
                "answer_text": "Ruby",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6259,
        "question_text": "Che cos’è un firewall?",
        "category": "Informatica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 24739,
                "answer_text": "Software grafico",
                "is_correct": 0
            },
            {
                "answer_id": 24736,
                "answer_text": "Sistema di protezione",
                "is_correct": 1
            },
            {
                "answer_id": 24738,
                "answer_text": "Hard disk",
                "is_correct": 0
            },
            {
                "answer_id": 24737,
                "answer_text": "Browser",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6260,
        "question_text": "Qual è l’estensione tipica di un file Python?",
        "category": "Informatica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 24740,
                "answer_text": ".py",
                "is_correct": 1
            },
            {
                "answer_id": 24743,
                "answer_text": ".cpp",
                "is_correct": 0
            },
            {
                "answer_id": 24742,
                "answer_text": ".js",
                "is_correct": 0
            },
            {
                "answer_id": 24741,
                "answer_text": ".java",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6261,
        "question_text": "Quale linguaggio è usato per lo styling web?",
        "category": "Informatica",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 24746,
                "answer_text": "JS",
                "is_correct": 0
            },
            {
                "answer_id": 24745,
                "answer_text": "HTML",
                "is_correct": 0
            },
            {
                "answer_id": 24744,
                "answer_text": "CSS",
                "is_correct": 1
            },
            {
                "answer_id": 24747,
                "answer_text": "SQL",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6558,
        "question_text": "Cosa fa un compilatore?",
        "category": "Informatica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 27134,
                "answer_text": "Modificare il codice",
                "is_correct": 0
            },
            {
                "answer_id": 27135,
                "answer_text": "Verificare errori",
                "is_correct": 0
            },
            {
                "answer_id": 27132,
                "answer_text": "Tradurre codice sorgente in linguaggio macchina",
                "is_correct": 1
            },
            {
                "answer_id": 27133,
                "answer_text": "Eseguire il programma",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6263,
        "question_text": "Quale organo regola la glicemia?",
        "category": "Medicina",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 24755,
                "answer_text": "Milza",
                "is_correct": 0
            },
            {
                "answer_id": 24754,
                "answer_text": "Fegato",
                "is_correct": 0
            },
            {
                "answer_id": 24753,
                "answer_text": "Rene",
                "is_correct": 0
            },
            {
                "answer_id": 24752,
                "answer_text": "Pancreas",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6264,
        "question_text": "Che parte del corpo è colpita dalla congiuntivite?",
        "category": "Medicina",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 24759,
                "answer_text": "Pelle",
                "is_correct": 0
            },
            {
                "answer_id": 24757,
                "answer_text": "Orecchio",
                "is_correct": 0
            },
            {
                "answer_id": 24758,
                "answer_text": "Gola",
                "is_correct": 0
            },
            {
                "answer_id": 24756,
                "answer_text": "Occhio",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6265,
        "question_text": "Cos'è l'ictus?",
        "category": "Medicina",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 24761,
                "answer_text": "Attacco cardiaco",
                "is_correct": 0
            },
            {
                "answer_id": 24762,
                "answer_text": "Crisi respiratoria",
                "is_correct": 0
            },
            {
                "answer_id": 24760,
                "answer_text": "Interruzione del flusso sanguigno cerebrale",
                "is_correct": 1
            },
            {
                "answer_id": 24763,
                "answer_text": "Frattura",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6266,
        "question_text": "Quale vitamina aiuta la coagulazione?",
        "category": "Medicina",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 24767,
                "answer_text": "Vitamina D",
                "is_correct": 0
            },
            {
                "answer_id": 24765,
                "answer_text": "Vitamina C",
                "is_correct": 0
            },
            {
                "answer_id": 24764,
                "answer_text": "Vitamina K",
                "is_correct": 1
            },
            {
                "answer_id": 24766,
                "answer_text": "Vitamina A",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6267,
        "question_text": "Cosa misura uno sfigmomanometro?",
        "category": "Medicina",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 24771,
                "answer_text": "Frequenza respiratoria",
                "is_correct": 0
            },
            {
                "answer_id": 24768,
                "answer_text": "Pressione arteriosa",
                "is_correct": 1
            },
            {
                "answer_id": 24769,
                "answer_text": "Temperatura",
                "is_correct": 0
            },
            {
                "answer_id": 24770,
                "answer_text": "Glicemia",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6268,
        "question_text": "Cosa rappresenta il deficit?",
        "category": "Economia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 24773,
                "answer_text": "Risparmio pubblico",
                "is_correct": 0
            },
            {
                "answer_id": 24775,
                "answer_text": "Investimento estero",
                "is_correct": 0
            },
            {
                "answer_id": 24772,
                "answer_text": "Spesa superiore alle entrate",
                "is_correct": 1
            },
            {
                "answer_id": 24774,
                "answer_text": "Bilancio positivo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6269,
        "question_text": "Cos’è il mercato azionario?",
        "category": "Economia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 24779,
                "answer_text": "Compravendita immobili",
                "is_correct": 0
            },
            {
                "answer_id": 24778,
                "answer_text": "Cambio valuta",
                "is_correct": 0
            },
            {
                "answer_id": 24776,
                "answer_text": "Scambio di azioni",
                "is_correct": 1
            },
            {
                "answer_id": 24777,
                "answer_text": "Vendita al dettaglio",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6270,
        "question_text": "Cosa fa un broker?",
        "category": "Economia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 24783,
                "answer_text": "Gestisce conti bancari",
                "is_correct": 0
            },
            {
                "answer_id": 24780,
                "answer_text": "Intermedia operazioni finanziarie",
                "is_correct": 1
            },
            {
                "answer_id": 24781,
                "answer_text": "Registra bilanci",
                "is_correct": 0
            },
            {
                "answer_id": 24782,
                "answer_text": "Emette titoli",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6271,
        "question_text": "Cos’è il PIL pro capite?",
        "category": "Economia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 24784,
                "answer_text": "PIL diviso per abitante",
                "is_correct": 1
            },
            {
                "answer_id": 24786,
                "answer_text": "Importazione annuale",
                "is_correct": 0
            },
            {
                "answer_id": 24787,
                "answer_text": "Quota azionaria",
                "is_correct": 0
            },
            {
                "answer_id": 24785,
                "answer_text": "Totale delle tasse",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6272,
        "question_text": "Che cos’è una recessione?",
        "category": "Economia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 24791,
                "answer_text": "Boom finanziario",
                "is_correct": 0
            },
            {
                "answer_id": 24788,
                "answer_text": "Calata dell’attività economica",
                "is_correct": 1
            },
            {
                "answer_id": 24789,
                "answer_text": "Aumento dei tassi",
                "is_correct": 0
            },
            {
                "answer_id": 24790,
                "answer_text": "Espansione del mercato",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6273,
        "question_text": "Cos’è la resilienza?",
        "category": "Psicologia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 24792,
                "answer_text": "Capacità di superare le difficoltà",
                "is_correct": 1
            },
            {
                "answer_id": 24795,
                "answer_text": "Disturbo dell’umore",
                "is_correct": 0
            },
            {
                "answer_id": 24794,
                "answer_text": "Tratto della personalità",
                "is_correct": 0
            },
            {
                "answer_id": 24793,
                "answer_text": "Stato di stress",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6274,
        "question_text": "Chi ha studiato il condizionamento classico?",
        "category": "Psicologia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 24799,
                "answer_text": "Erikson",
                "is_correct": 0
            },
            {
                "answer_id": 24796,
                "answer_text": "Pavlov",
                "is_correct": 1
            },
            {
                "answer_id": 24797,
                "answer_text": "Freud",
                "is_correct": 0
            },
            {
                "answer_id": 24798,
                "answer_text": "Jung",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6275,
        "question_text": "Cos’è il subconscio?",
        "category": "Psicologia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 24802,
                "answer_text": "Attività logica",
                "is_correct": 0
            },
            {
                "answer_id": 24801,
                "answer_text": "Memoria a breve termine",
                "is_correct": 0
            },
            {
                "answer_id": 24803,
                "answer_text": "Reattività automatica",
                "is_correct": 0
            },
            {
                "answer_id": 24800,
                "answer_text": "Parte non consapevole della mente",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6276,
        "question_text": "Cosa studia la psicologia evolutiva?",
        "category": "Psicologia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 24807,
                "answer_text": "Cognizione animale",
                "is_correct": 0
            },
            {
                "answer_id": 24806,
                "answer_text": "Psicopatologie",
                "is_correct": 0
            },
            {
                "answer_id": 24804,
                "answer_text": "Sviluppo umano",
                "is_correct": 1
            },
            {
                "answer_id": 24805,
                "answer_text": "Relazioni sociali",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6277,
        "question_text": "Qual è un sintomo comune della depressione?",
        "category": "Psicologia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 24808,
                "answer_text": "Anedonia",
                "is_correct": 1
            },
            {
                "answer_id": 24810,
                "answer_text": "Ipersensibilità",
                "is_correct": 0
            },
            {
                "answer_id": 24811,
                "answer_text": "Confusione",
                "is_correct": 0
            },
            {
                "answer_id": 24809,
                "answer_text": "Euforia",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6278,
        "question_text": "Chi è il cantante dei Queen?",
        "category": "Musica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 24815,
                "answer_text": "Elvis Presley",
                "is_correct": 0
            },
            {
                "answer_id": 24814,
                "answer_text": "Mick Jagger",
                "is_correct": 0
            },
            {
                "answer_id": 24812,
                "answer_text": "Freddie Mercury",
                "is_correct": 1
            },
            {
                "answer_id": 24813,
                "answer_text": "Bono",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6279,
        "question_text": "Cos'è un'ottava?",
        "category": "Musica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 24817,
                "answer_text": "Tipo di ritmo",
                "is_correct": 0
            },
            {
                "answer_id": 24819,
                "answer_text": "Scala cromatica",
                "is_correct": 0
            },
            {
                "answer_id": 24816,
                "answer_text": "Intervallo di 8 note",
                "is_correct": 1
            },
            {
                "answer_id": 24818,
                "answer_text": "Tecnica vocale",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6280,
        "question_text": "Chi ha scritto 'La Traviata'?",
        "category": "Musica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 24821,
                "answer_text": "Gioachino Rossini",
                "is_correct": 0
            },
            {
                "answer_id": 24822,
                "answer_text": "Giacomo Puccini",
                "is_correct": 0
            },
            {
                "answer_id": 24820,
                "answer_text": "Giuseppe Verdi",
                "is_correct": 1
            },
            {
                "answer_id": 24823,
                "answer_text": "Antonio Vivaldi",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6281,
        "question_text": "Qual è la durata di una semiminima?",
        "category": "Musica",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 24824,
                "answer_text": "Un quarto",
                "is_correct": 1
            },
            {
                "answer_id": 24827,
                "answer_text": "Un intero",
                "is_correct": 0
            },
            {
                "answer_id": 24826,
                "answer_text": "Una metà",
                "is_correct": 0
            },
            {
                "answer_id": 24825,
                "answer_text": "Un ottavo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6282,
        "question_text": "Cosa significa 'allegro' in musica?",
        "category": "Musica",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 24828,
                "answer_text": "Veloce",
                "is_correct": 1
            },
            {
                "answer_id": 24831,
                "answer_text": "Triste",
                "is_correct": 0
            },
            {
                "answer_id": 24830,
                "answer_text": "Moderato",
                "is_correct": 0
            },
            {
                "answer_id": 24829,
                "answer_text": "Lento",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6284,
        "question_text": "Cos'è il cubismo?",
        "category": "Arte",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 24839,
                "answer_text": "Espressionismo romantico",
                "is_correct": 0
            },
            {
                "answer_id": 24836,
                "answer_text": "Movimento artistico astratto",
                "is_correct": 1
            },
            {
                "answer_id": 24837,
                "answer_text": "Tecnica scultorea",
                "is_correct": 0
            },
            {
                "answer_id": 24838,
                "answer_text": "Pittura naturalistica",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6285,
        "question_text": "Chi ha realizzato 'Il bacio'?",
        "category": "Arte",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 24842,
                "answer_text": "Kandinsky",
                "is_correct": 0
            },
            {
                "answer_id": 24841,
                "answer_text": "Egon Schiele",
                "is_correct": 0
            },
            {
                "answer_id": 24843,
                "answer_text": "Munch",
                "is_correct": 0
            },
            {
                "answer_id": 24840,
                "answer_text": "Gustav Klimt",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6286,
        "question_text": "Quale materiale usava Rodin?",
        "category": "Arte",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 24845,
                "answer_text": "Marmo",
                "is_correct": 0
            },
            {
                "answer_id": 24844,
                "answer_text": "Bronzo",
                "is_correct": 1
            },
            {
                "answer_id": 24847,
                "answer_text": "Terracotta",
                "is_correct": 0
            },
            {
                "answer_id": 24846,
                "answer_text": "Legno",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6287,
        "question_text": "Chi ha affrescato la Cappella degli Scrovegni?",
        "category": "Arte",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 24850,
                "answer_text": "Piero della Francesca",
                "is_correct": 0
            },
            {
                "answer_id": 24851,
                "answer_text": "Caravaggio",
                "is_correct": 0
            },
            {
                "answer_id": 24848,
                "answer_text": "Giotto",
                "is_correct": 1
            },
            {
                "answer_id": 24849,
                "answer_text": "Raffaello",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6288,
        "question_text": "Chi ha vinto gli Europei 2020?",
        "category": "Sport",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 24852,
                "answer_text": "Italia",
                "is_correct": 1
            },
            {
                "answer_id": 24853,
                "answer_text": "Inghilterra",
                "is_correct": 0
            },
            {
                "answer_id": 24854,
                "answer_text": "Spagna",
                "is_correct": 0
            },
            {
                "answer_id": 24855,
                "answer_text": "Germania",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6289,
        "question_text": "Quale sport si gioca con una palla ovale?",
        "category": "Sport",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 24858,
                "answer_text": "Basket",
                "is_correct": 0
            },
            {
                "answer_id": 24859,
                "answer_text": "Baseball",
                "is_correct": 0
            },
            {
                "answer_id": 24857,
                "answer_text": "Calcio",
                "is_correct": 0
            },
            {
                "answer_id": 24856,
                "answer_text": "Rugby",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6290,
        "question_text": "Che distanza copre una maratona?",
        "category": "Sport",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 24863,
                "answer_text": "50 km",
                "is_correct": 0
            },
            {
                "answer_id": 24862,
                "answer_text": "10 km",
                "is_correct": 0
            },
            {
                "answer_id": 24860,
                "answer_text": "42,195 km",
                "is_correct": 1
            },
            {
                "answer_id": 24861,
                "answer_text": "21 km",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6291,
        "question_text": "Chi è noto come il GOAT nel tennis?",
        "category": "Sport",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 24865,
                "answer_text": "Rafael Nadal",
                "is_correct": 0
            },
            {
                "answer_id": 24867,
                "answer_text": "Andy Murray",
                "is_correct": 0
            },
            {
                "answer_id": 24864,
                "answer_text": "Roger Federer",
                "is_correct": 1
            },
            {
                "answer_id": 24866,
                "answer_text": "Novak Djokovic",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6292,
        "question_text": "Cosa indica il termine 'hole in one'?",
        "category": "Sport",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 24869,
                "answer_text": "Due colpi in buca",
                "is_correct": 0
            },
            {
                "answer_id": 24870,
                "answer_text": "Par perfetto",
                "is_correct": 0
            },
            {
                "answer_id": 24871,
                "answer_text": "Vittoria al match",
                "is_correct": 0
            },
            {
                "answer_id": 24868,
                "answer_text": "Buca con un colpo",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6550,
        "question_text": "Chi è il maestro di Naruto?",
        "category": "Anime",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 27102,
                "answer_text": "Iruka",
                "is_correct": 0
            },
            {
                "answer_id": 27103,
                "answer_text": "Minato",
                "is_correct": 0
            },
            {
                "answer_id": 27100,
                "answer_text": "Kakashi Hatake",
                "is_correct": 1
            },
            {
                "answer_id": 27101,
                "answer_text": "Jiraiya",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 8340,
        "question_text": "Come si chiama il quirk di Deku?",
        "category": "Anime",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 33062,
                "answer_text": "Explosion",
                "is_correct": 0
            },
            {
                "answer_id": 33060,
                "answer_text": "One For All",
                "is_correct": 1
            },
            {
                "answer_id": 33061,
                "answer_text": "Half Cold Half Hot",
                "is_correct": 0
            },
            {
                "answer_id": 33063,
                "answer_text": "Decay",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 8341,
        "question_text": "Cosa significa il verbo 'run' in italiano?",
        "category": "Inglese",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 33064,
                "answer_text": "Correre",
                "is_correct": 1
            },
            {
                "answer_id": 33067,
                "answer_text": "Parlare",
                "is_correct": 0
            },
            {
                "answer_id": 33066,
                "answer_text": "Mangiare",
                "is_correct": 0
            },
            {
                "answer_id": 33065,
                "answer_text": "Scrivere",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 8342,
        "question_text": "Qual è il significato di 'beautiful'?",
        "category": "Inglese",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 33068,
                "answer_text": "Bello",
                "is_correct": 1
            },
            {
                "answer_id": 33069,
                "answer_text": "Grande",
                "is_correct": 0
            },
            {
                "answer_id": 33070,
                "answer_text": "Lento",
                "is_correct": 0
            },
            {
                "answer_id": 33071,
                "answer_text": "Allegro",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 8343,
        "question_text": "Come si traduce 'book'?",
        "category": "Inglese",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 33074,
                "answer_text": "Tavolo",
                "is_correct": 0
            },
            {
                "answer_id": 33075,
                "answer_text": "Penna",
                "is_correct": 0
            },
            {
                "answer_id": 33073,
                "answer_text": "Sedia",
                "is_correct": 0
            },
            {
                "answer_id": 33072,
                "answer_text": "Libro",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 8344,
        "question_text": "Chi è il protagonista di Breaking Bad?",
        "category": "Serie TV",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 33079,
                "answer_text": "Hank Schrader",
                "is_correct": 0
            },
            {
                "answer_id": 33076,
                "answer_text": "Walter White",
                "is_correct": 1
            },
            {
                "answer_id": 33077,
                "answer_text": "Jesse Pinkman",
                "is_correct": 0
            },
            {
                "answer_id": 33078,
                "answer_text": "Saul Goodman",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 8346,
        "question_text": "In quale serie TV troviamo un laboratorio di metanfetamina?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 33084,
                "answer_text": "Breaking Bad",
                "is_correct": 1
            },
            {
                "answer_id": 33085,
                "answer_text": "Better Call Saul",
                "is_correct": 0
            },
            {
                "answer_id": 33087,
                "answer_text": "Ozark",
                "is_correct": 0
            },
            {
                "answer_id": 33086,
                "answer_text": "Narcos",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 8347,
        "question_text": "Cosa significa l'acronimo CPU?",
        "category": "Informatica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 33091,
                "answer_text": "Memoria centrale",
                "is_correct": 0
            },
            {
                "answer_id": 33090,
                "answer_text": "Sistema operativo",
                "is_correct": 0
            },
            {
                "answer_id": 33089,
                "answer_text": "Processore di rete",
                "is_correct": 0
            },
            {
                "answer_id": 33088,
                "answer_text": "Unità di elaborazione centrale",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 8330,
        "question_text": "Quale linguaggio si usa per creare siti web?",
        "category": "Informatica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 33020,
                "answer_text": "HTML",
                "is_correct": 1
            },
            {
                "answer_id": 33021,
                "answer_text": "Python",
                "is_correct": 0
            },
            {
                "answer_id": 33023,
                "answer_text": "SQL",
                "is_correct": 0
            },
            {
                "answer_id": 33022,
                "answer_text": "C#",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 8331,
        "question_text": "Cos’è una variabile in programmazione?",
        "category": "Informatica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 33026,
                "answer_text": "Funzione",
                "is_correct": 0
            },
            {
                "answer_id": 33024,
                "answer_text": "Spazio per memorizzare dati",
                "is_correct": 1
            },
            {
                "answer_id": 33027,
                "answer_text": "Ciclo",
                "is_correct": 0
            },
            {
                "answer_id": 33025,
                "answer_text": "Errore",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 8332,
        "question_text": "Cosa rappresenta l'inflazione?",
        "category": "Economia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 33028,
                "answer_text": "Aumento dei prezzi",
                "is_correct": 1
            },
            {
                "answer_id": 33030,
                "answer_text": "Diminuzione della moneta",
                "is_correct": 0
            },
            {
                "answer_id": 33031,
                "answer_text": "Crescita del PIL",
                "is_correct": 0
            },
            {
                "answer_id": 33029,
                "answer_text": "Aumento dei salari",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 8333,
        "question_text": "Cosa fa un investimento?",
        "category": "Economia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 33032,
                "answer_text": "Aumenta il capitale",
                "is_correct": 1
            },
            {
                "answer_id": 33033,
                "answer_text": "Riduce il debito",
                "is_correct": 0
            },
            {
                "answer_id": 33035,
                "answer_text": "Fa perdere soldi",
                "is_correct": 0
            },
            {
                "answer_id": 33034,
                "answer_text": "Genera inflazione",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 8334,
        "question_text": "Cos’è il PIL?",
        "category": "Economia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 33039,
                "answer_text": "Programma Importazioni Locali",
                "is_correct": 0
            },
            {
                "answer_id": 33038,
                "answer_text": "Prestito Internazionale Locale",
                "is_correct": 0
            },
            {
                "answer_id": 33037,
                "answer_text": "Prezzo Intero Lordo",
                "is_correct": 0
            },
            {
                "answer_id": 33036,
                "answer_text": "Prodotto Interno Lordo",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 8336,
        "question_text": "Quanti continenti ci sono?",
        "category": "Cultura Generale",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 33047,
                "answer_text": "8",
                "is_correct": 0
            },
            {
                "answer_id": 33044,
                "answer_text": "7",
                "is_correct": 1
            },
            {
                "answer_id": 33046,
                "answer_text": "6",
                "is_correct": 0
            },
            {
                "answer_id": 33045,
                "answer_text": "5",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6548,
        "question_text": "Chi è il protagonista di 'One Piece'?",
        "category": "Anime",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 27093,
                "answer_text": "Zoro",
                "is_correct": 0
            },
            {
                "answer_id": 27095,
                "answer_text": "Usopp",
                "is_correct": 0
            },
            {
                "answer_id": 27092,
                "answer_text": "Monkey D. Luffy",
                "is_correct": 1
            },
            {
                "answer_id": 27094,
                "answer_text": "Sanji",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6549,
        "question_text": "In quale anime si trovano i personaggi di Goku e Vegeta?",
        "category": "Anime",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 27097,
                "answer_text": "Naruto",
                "is_correct": 0
            },
            {
                "answer_id": 27096,
                "answer_text": "Dragon Ball",
                "is_correct": 1
            },
            {
                "answer_id": 27099,
                "answer_text": "Attack on Titan",
                "is_correct": 0
            },
            {
                "answer_id": 27098,
                "answer_text": "Bleach",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6551,
        "question_text": "Qual è il potere di Izuku Midoriya in 'My Hero Academia'?",
        "category": "Anime",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 27107,
                "answer_text": "Invisibility",
                "is_correct": 0
            },
            {
                "answer_id": 27104,
                "answer_text": "One For All",
                "is_correct": 1
            },
            {
                "answer_id": 27105,
                "answer_text": "Fire Punch",
                "is_correct": 0
            },
            {
                "answer_id": 27106,
                "answer_text": "Explosion",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6552,
        "question_text": "In quale anime i personaggi combattono contro giganti?",
        "category": "Anime",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 27110,
                "answer_text": "One Piece",
                "is_correct": 0
            },
            {
                "answer_id": 27109,
                "answer_text": "Naruto",
                "is_correct": 0
            },
            {
                "answer_id": 27111,
                "answer_text": "Fullmetal Alchemist",
                "is_correct": 0
            },
            {
                "answer_id": 27108,
                "answer_text": "Attack on Titan",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6553,
        "question_text": "Chi è l'attore che interpreta Walter White?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 27112,
                "answer_text": "Bryan Cranston",
                "is_correct": 1
            },
            {
                "answer_id": 27115,
                "answer_text": "Giancarlo Esposito",
                "is_correct": 0
            },
            {
                "answer_id": 27114,
                "answer_text": "Bob Odenkirk",
                "is_correct": 0
            },
            {
                "answer_id": 27113,
                "answer_text": "Aaron Paul",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6554,
        "question_text": "In quale serie il personaggio principale è un detective con un cane robot?",
        "category": "Serie TV",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 27117,
                "answer_text": "House",
                "is_correct": 0
            },
            {
                "answer_id": 27119,
                "answer_text": "Luther",
                "is_correct": 0
            },
            {
                "answer_id": 27118,
                "answer_text": "Dexter",
                "is_correct": 0
            },
            {
                "answer_id": 27116,
                "answer_text": "Sherlock",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6555,
        "question_text": "In quale serie TV si trova la città di Hawkins?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 27122,
                "answer_text": "Twin Peaks",
                "is_correct": 0
            },
            {
                "answer_id": 27123,
                "answer_text": "Lost",
                "is_correct": 0
            },
            {
                "answer_id": 27121,
                "answer_text": "The X-Files",
                "is_correct": 0
            },
            {
                "answer_id": 27120,
                "answer_text": "Stranger Things",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6556,
        "question_text": "Chi è il protagonista di The Witcher?",
        "category": "Serie TV",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 27125,
                "answer_text": "Yennefer",
                "is_correct": 0
            },
            {
                "answer_id": 27124,
                "answer_text": "Geralt di Rivia",
                "is_correct": 1
            },
            {
                "answer_id": 27127,
                "answer_text": "Jaskier",
                "is_correct": 0
            },
            {
                "answer_id": 27126,
                "answer_text": "Ciri",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6557,
        "question_text": "In quale serie i personaggi sono i membri di un gruppo di criminali?",
        "category": "Serie TV",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 27130,
                "answer_text": "Ozark",
                "is_correct": 0
            },
            {
                "answer_id": 27129,
                "answer_text": "Narcos",
                "is_correct": 0
            },
            {
                "answer_id": 27128,
                "answer_text": "Money Heist",
                "is_correct": 1
            },
            {
                "answer_id": 27131,
                "answer_text": "Prison Break",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6559,
        "question_text": "Cos'è il cloud computing?",
        "category": "Informatica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 27137,
                "answer_text": "Elaborazione dati su server locali",
                "is_correct": 0
            },
            {
                "answer_id": 27136,
                "answer_text": "Archiviazione e gestione dei dati tramite internet",
                "is_correct": 1
            },
            {
                "answer_id": 27139,
                "answer_text": "Un sistema operativo mobile",
                "is_correct": 0
            },
            {
                "answer_id": 27138,
                "answer_text": "Un tipo di virus informatico",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6561,
        "question_text": "Cosa significa l'acronimo URL?",
        "category": "Informatica",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 27146,
                "answer_text": "Ultimate Resource Locator",
                "is_correct": 0
            },
            {
                "answer_id": 27145,
                "answer_text": "Universal Resource Locator",
                "is_correct": 0
            },
            {
                "answer_id": 27144,
                "answer_text": "Uniform Resource Locator",
                "is_correct": 1
            },
            {
                "answer_id": 27147,
                "answer_text": "Unique Resource Locator",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6563,
        "question_text": "Cos'è un ECG?",
        "category": "Medicina",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 27154,
                "answer_text": "Risonanza magnetica",
                "is_correct": 0
            },
            {
                "answer_id": 27155,
                "answer_text": "Tac",
                "is_correct": 0
            },
            {
                "answer_id": 27152,
                "answer_text": "Elettrocardiogramma",
                "is_correct": 1
            },
            {
                "answer_id": 27153,
                "answer_text": "Ecografia",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6564,
        "question_text": "Cosa fa il pancreas?",
        "category": "Medicina",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 27157,
                "answer_text": "Produce adrenalina",
                "is_correct": 0
            },
            {
                "answer_id": 27156,
                "answer_text": "Produce insulina",
                "is_correct": 1
            },
            {
                "answer_id": 27159,
                "answer_text": "Regola la temperatura corporea",
                "is_correct": 0
            },
            {
                "answer_id": 27158,
                "answer_text": "Filtra il sangue",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6565,
        "question_text": "Cos'è un'infezione batterica?",
        "category": "Medicina",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 27160,
                "answer_text": "Malattia causata da batteri",
                "is_correct": 1
            },
            {
                "answer_id": 27161,
                "answer_text": "Malattia causata da virus",
                "is_correct": 0
            },
            {
                "answer_id": 27162,
                "answer_text": "Malattia causata da funghi",
                "is_correct": 0
            },
            {
                "answer_id": 27163,
                "answer_text": "Malattia causata da parassiti",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6566,
        "question_text": "Quale vitamina è prodotta dalla pelle?",
        "category": "Medicina",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 27167,
                "answer_text": "Vitamina C",
                "is_correct": 0
            },
            {
                "answer_id": 27165,
                "answer_text": "Vitamina A",
                "is_correct": 0
            },
            {
                "answer_id": 27166,
                "answer_text": "Vitamina E",
                "is_correct": 0
            },
            {
                "answer_id": 27164,
                "answer_text": "Vitamina D",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6567,
        "question_text": "Che cosa è la leucemia?",
        "category": "Medicina",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 27168,
                "answer_text": "Un tipo di cancro del sangue",
                "is_correct": 1
            },
            {
                "answer_id": 27171,
                "answer_text": "Disturbo nervoso",
                "is_correct": 0
            },
            {
                "answer_id": 27169,
                "answer_text": "Malattia del cuore",
                "is_correct": 0
            },
            {
                "answer_id": 27170,
                "answer_text": "Malattia polmonare",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6569,
        "question_text": "Cosa significa inflazione?",
        "category": "Economia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 27177,
                "answer_text": "Riduzione dei salari",
                "is_correct": 0
            },
            {
                "answer_id": 27176,
                "answer_text": "Aumento dei prezzi di beni e servizi",
                "is_correct": 1
            },
            {
                "answer_id": 27178,
                "answer_text": "Crescita dei salari",
                "is_correct": 0
            },
            {
                "answer_id": 27179,
                "answer_text": "Stagnazione dei prezzi",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6570,
        "question_text": "Che cos'è un investimento?",
        "category": "Economia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 27183,
                "answer_text": "Riduzione del debito",
                "is_correct": 0
            },
            {
                "answer_id": 27181,
                "answer_text": "Aumento di prezzo di un bene",
                "is_correct": 0
            },
            {
                "answer_id": 27180,
                "answer_text": "Impegno di denaro per generare un guadagno",
                "is_correct": 1
            },
            {
                "answer_id": 27182,
                "answer_text": "Pagamento di una tassa",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6571,
        "question_text": "Cos'è la deflazione?",
        "category": "Economia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 27184,
                "answer_text": "Diminuzione generale dei prezzi",
                "is_correct": 1
            },
            {
                "answer_id": 27185,
                "answer_text": "Aumento dei prezzi",
                "is_correct": 0
            },
            {
                "answer_id": 27186,
                "answer_text": "Riduzione dei tassi di interesse",
                "is_correct": 0
            },
            {
                "answer_id": 27187,
                "answer_text": "Crescita economica",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6572,
        "question_text": "Cosa si intende con 'mercato azionario'?",
        "category": "Economia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 27191,
                "answer_text": "Un'agenzia di credito",
                "is_correct": 0
            },
            {
                "answer_id": 27188,
                "answer_text": "Luogo dove vengono scambiate le azioni",
                "is_correct": 1
            },
            {
                "answer_id": 27189,
                "answer_text": "Un mercato di beni alimentari",
                "is_correct": 0
            },
            {
                "answer_id": 27190,
                "answer_text": "Un sistema di scambio di valute",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6573,
        "question_text": "Cos'è la resilienza?",
        "category": "Psicologia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 27192,
                "answer_text": "Capacità di superare traumi e difficoltà",
                "is_correct": 1
            },
            {
                "answer_id": 27194,
                "answer_text": "Depressione",
                "is_correct": 0
            },
            {
                "answer_id": 27195,
                "answer_text": "Fobia",
                "is_correct": 0
            },
            {
                "answer_id": 27193,
                "answer_text": "Ansia",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6574,
        "question_text": "Chi ha creato la teoria dell'inconscio?",
        "category": "Psicologia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 27198,
                "answer_text": "B.F. Skinner",
                "is_correct": 0
            },
            {
                "answer_id": 27199,
                "answer_text": "Erik Erikson",
                "is_correct": 0
            },
            {
                "answer_id": 27196,
                "answer_text": "Sigmund Freud",
                "is_correct": 1
            },
            {
                "answer_id": 27197,
                "answer_text": "Carl Jung",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6575,
        "question_text": "Cosa si intende per 'memoria a lungo termine'?",
        "category": "Psicologia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 27200,
                "answer_text": "Capacità di trattenere informazioni per anni",
                "is_correct": 1
            },
            {
                "answer_id": 27202,
                "answer_text": "Memoria visiva",
                "is_correct": 0
            },
            {
                "answer_id": 27201,
                "answer_text": "Memoria breve",
                "is_correct": 0
            },
            {
                "answer_id": 27203,
                "answer_text": "Memoria episodica",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6576,
        "question_text": "Cos'è un disturbo d'ansia?",
        "category": "Psicologia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 27206,
                "answer_text": "Panic attack",
                "is_correct": 0
            },
            {
                "answer_id": 27205,
                "answer_text": "Euforia",
                "is_correct": 0
            },
            {
                "answer_id": 27207,
                "answer_text": "Apatia",
                "is_correct": 0
            },
            {
                "answer_id": 27204,
                "answer_text": "Stato di preoccupazione eccessiva",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6577,
        "question_text": "Cosa studia la psicologia sociale?",
        "category": "Psicologia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 27209,
                "answer_text": "Funzioni cerebrali",
                "is_correct": 0
            },
            {
                "answer_id": 27210,
                "answer_text": "Comportamenti individuali",
                "is_correct": 0
            },
            {
                "answer_id": 27211,
                "answer_text": "Teorie sull'intelligenza",
                "is_correct": 0
            },
            {
                "answer_id": 27208,
                "answer_text": "Comportamento umano in contesti di gruppo",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6578,
        "question_text": "Chi ha scritto 'Imagine'?",
        "category": "Musica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 27212,
                "answer_text": "John Lennon",
                "is_correct": 1
            },
            {
                "answer_id": 27213,
                "answer_text": "Paul McCartney",
                "is_correct": 0
            },
            {
                "answer_id": 27214,
                "answer_text": "Elton John",
                "is_correct": 0
            },
            {
                "answer_id": 27215,
                "answer_text": "Bono",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6579,
        "question_text": "Cos'è un accordo in musica?",
        "category": "Musica",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 27216,
                "answer_text": "Combinazione di note suonate insieme",
                "is_correct": 1
            },
            {
                "answer_id": 27219,
                "answer_text": "Una melodia",
                "is_correct": 0
            },
            {
                "answer_id": 27217,
                "answer_text": "Un ritmo veloce",
                "is_correct": 0
            },
            {
                "answer_id": 27218,
                "answer_text": "Un tipo di strumento",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6580,
        "question_text": "Cosa significa il termine 'coda' in musica?",
        "category": "Musica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 27220,
                "answer_text": "Parte finale di un brano",
                "is_correct": 1
            },
            {
                "answer_id": 27222,
                "answer_text": "Tipo di tempo musicale",
                "is_correct": 0
            },
            {
                "answer_id": 27221,
                "answer_text": "Intervallo tra due note",
                "is_correct": 0
            },
            {
                "answer_id": 27223,
                "answer_text": "Tecnica vocale",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6581,
        "question_text": "Cos'è una sinfonia?",
        "category": "Musica",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 27224,
                "answer_text": "Composizione musicale per orchestra",
                "is_correct": 1
            },
            {
                "answer_id": 27226,
                "answer_text": "Un tipo di danza",
                "is_correct": 0
            },
            {
                "answer_id": 27227,
                "answer_text": "Un'associazione musicale",
                "is_correct": 0
            },
            {
                "answer_id": 27225,
                "answer_text": "Una canzone pop",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6582,
        "question_text": "Chi è l'autore di 'Vivaldi's Four Seasons'?",
        "category": "Musica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 27228,
                "answer_text": "Antonio Vivaldi",
                "is_correct": 1
            },
            {
                "answer_id": 27231,
                "answer_text": "Johann Sebastian Bach",
                "is_correct": 0
            },
            {
                "answer_id": 27230,
                "answer_text": "Wolfgang Amadeus Mozart",
                "is_correct": 0
            },
            {
                "answer_id": 27229,
                "answer_text": "Ludwig van Beethoven",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6583,
        "question_text": "Chi ha dipinto 'La Guernica'?",
        "category": "Arte",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 27232,
                "answer_text": "Pablo Picasso",
                "is_correct": 1
            },
            {
                "answer_id": 27233,
                "answer_text": "Claude Monet",
                "is_correct": 0
            },
            {
                "answer_id": 27234,
                "answer_text": "Leonardo da Vinci",
                "is_correct": 0
            },
            {
                "answer_id": 27235,
                "answer_text": "Salvador Dalí",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6584,
        "question_text": "Chi ha realizzato la scultura del David?",
        "category": "Arte",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 27238,
                "answer_text": "Caravaggio",
                "is_correct": 0
            },
            {
                "answer_id": 27237,
                "answer_text": "Donatello",
                "is_correct": 0
            },
            {
                "answer_id": 27239,
                "answer_text": "Gian Lorenzo Bernini",
                "is_correct": 0
            },
            {
                "answer_id": 27236,
                "answer_text": "Michelangelo",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6585,
        "question_text": "Cosa rappresenta il termine 'Rinascimento'?",
        "category": "Arte",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 27241,
                "answer_text": "Stile barocco",
                "is_correct": 0
            },
            {
                "answer_id": 27243,
                "answer_text": "Movimento romantico",
                "is_correct": 0
            },
            {
                "answer_id": 27240,
                "answer_text": "Periodo di grande sviluppo artistico",
                "is_correct": 1
            },
            {
                "answer_id": 27242,
                "answer_text": "Arte medievale",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6587,
        "question_text": "Chi ha creato 'La scuola di Atene'?",
        "category": "Arte",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 27251,
                "answer_text": "Tintoretto",
                "is_correct": 0
            },
            {
                "answer_id": 27248,
                "answer_text": "Raffaello",
                "is_correct": 1
            },
            {
                "answer_id": 27250,
                "answer_text": "Caravaggio",
                "is_correct": 0
            },
            {
                "answer_id": 27249,
                "answer_text": "Giotto",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6589,
        "question_text": "Cos'è un touchdown nel football americano?",
        "category": "Sport",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 27257,
                "answer_text": "Un fallo",
                "is_correct": 0
            },
            {
                "answer_id": 27256,
                "answer_text": "Segnare punti portando la palla oltre la linea di meta",
                "is_correct": 1
            },
            {
                "answer_id": 27258,
                "answer_text": "Un passaggio",
                "is_correct": 0
            },
            {
                "answer_id": 27259,
                "answer_text": "Una tecnica di difesa",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6590,
        "question_text": "Chi ha vinto più medaglie olimpiche?",
        "category": "Sport",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 27262,
                "answer_text": "Simone Biles",
                "is_correct": 0
            },
            {
                "answer_id": 27260,
                "answer_text": "Michael Phelps",
                "is_correct": 1
            },
            {
                "answer_id": 27263,
                "answer_text": "Larisa Latynina",
                "is_correct": 0
            },
            {
                "answer_id": 27261,
                "answer_text": "Usain Bolt",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 6591,
        "question_text": "Cosa significa il termine 'par' nel golf?",
        "category": "Sport",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 27267,
                "answer_text": "Doppio colpo",
                "is_correct": 0
            },
            {
                "answer_id": 27266,
                "answer_text": "Un colpo in meno",
                "is_correct": 0
            },
            {
                "answer_id": 27265,
                "answer_text": "Un colpo in più",
                "is_correct": 0
            },
            {
                "answer_id": 27264,
                "answer_text": "Punteggio standard per una buca",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 6592,
        "question_text": "Chi ha scritto la regola del calcio?",
        "category": "Sport",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 27269,
                "answer_text": "FIFA",
                "is_correct": 0
            },
            {
                "answer_id": 27270,
                "answer_text": "UEFA",
                "is_correct": 0
            },
            {
                "answer_id": 27271,
                "answer_text": "Serie A",
                "is_correct": 0
            },
            {
                "answer_id": 27268,
                "answer_text": "Sheffield FC",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 25000,
        "question_text": "Come si chiama il protagonista di One Piece?",
        "category": "Anime",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45001,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 45000,
                "answer_text": "Monkey D. Luffy",
                "is_correct": 1
            },
            {
                "answer_id": 45002,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 45003,
                "answer_text": "Shinji",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25001,
        "question_text": "Come si chiama il protagonista di Naruto?",
        "category": "Anime",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45007,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 45004,
                "answer_text": "Naruto Uzumaki",
                "is_correct": 1
            },
            {
                "answer_id": 45005,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 45006,
                "answer_text": "Vegeta",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25002,
        "question_text": "Come si chiama il protagonista di Attack on Titan?",
        "category": "Anime",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45009,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 45008,
                "answer_text": "Eren Jaeger",
                "is_correct": 1
            },
            {
                "answer_id": 45011,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 45010,
                "answer_text": "Vegeta",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25003,
        "question_text": "Come si chiama il protagonista di Bleach?",
        "category": "Anime",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45015,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 45012,
                "answer_text": "Ichigo Kurosaki",
                "is_correct": 1
            },
            {
                "answer_id": 45014,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 45013,
                "answer_text": "Sasuke",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25004,
        "question_text": "Come si chiama il protagonista di Death Note?",
        "category": "Anime",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45019,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 45017,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 45018,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 45016,
                "answer_text": "Light Yagami",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 25005,
        "question_text": "Come si chiama il protagonista di Dragon Ball?",
        "category": "Anime",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45021,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 45020,
                "answer_text": "Goku",
                "is_correct": 1
            },
            {
                "answer_id": 45023,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 45022,
                "answer_text": "Vegeta",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25006,
        "question_text": "Come si chiama il protagonista di My Hero Academia?",
        "category": "Anime",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45024,
                "answer_text": "Izuku Midoriya",
                "is_correct": 1
            },
            {
                "answer_id": 45027,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 45025,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 45026,
                "answer_text": "Vegeta",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25007,
        "question_text": "Come si chiama il protagonista di Fullmetal Alchemist?",
        "category": "Anime",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45030,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 45031,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 45028,
                "answer_text": "Edward Elric",
                "is_correct": 1
            },
            {
                "answer_id": 45029,
                "answer_text": "Sasuke",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25008,
        "question_text": "Come si chiama il protagonista di One Punch Man?",
        "category": "Anime",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45034,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 45033,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 45032,
                "answer_text": "Saitama",
                "is_correct": 1
            },
            {
                "answer_id": 45035,
                "answer_text": "Shinji",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25009,
        "question_text": "Come si chiama il protagonista di Tokyo Ghoul?",
        "category": "Anime",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45037,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 45039,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 45036,
                "answer_text": "Kaneki Ken",
                "is_correct": 1
            },
            {
                "answer_id": 45038,
                "answer_text": "Vegeta",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25015,
        "question_text": "Chi è il personaggio principale della serie Breaking Bad?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45061,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 45063,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 45062,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 45060,
                "answer_text": "Walter White",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 25016,
        "question_text": "Chi è il personaggio principale della serie Stranger Things?",
        "category": "Serie TV",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45066,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 45064,
                "answer_text": "Eleven",
                "is_correct": 1
            },
            {
                "answer_id": 45067,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 45065,
                "answer_text": "Tyrion",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25017,
        "question_text": "Chi è il personaggio principale della serie Sherlock?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45071,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 45070,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 45069,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 45068,
                "answer_text": "Sherlock Holmes",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 25018,
        "question_text": "Chi è il personaggio principale della serie The Office?",
        "category": "Serie TV",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45073,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 45074,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 45075,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 45072,
                "answer_text": "Michael Scott",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 25019,
        "question_text": "Chi è il personaggio principale della serie Game of Thrones?",
        "category": "Serie TV",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45079,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 45077,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 45076,
                "answer_text": "Jon Snow",
                "is_correct": 1
            },
            {
                "answer_id": 45078,
                "answer_text": "Rick",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25020,
        "question_text": "Chi è il personaggio principale della serie House of Cards?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45081,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 45083,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 45080,
                "answer_text": "Frank Underwood",
                "is_correct": 1
            },
            {
                "answer_id": 45082,
                "answer_text": "Rick",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25021,
        "question_text": "Chi è il personaggio principale della serie Dexter?",
        "category": "Serie TV",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45086,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 45087,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 45085,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 45084,
                "answer_text": "Dexter Morgan",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 25022,
        "question_text": "Chi è il personaggio principale della serie Better Call Saul?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45091,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 45090,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 45089,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 45088,
                "answer_text": "Saul Goodman",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 25023,
        "question_text": "Chi è il personaggio principale della serie Lucifer?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45092,
                "answer_text": "Lucifer Morningstar",
                "is_correct": 1
            },
            {
                "answer_id": 45094,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 45093,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 45095,
                "answer_text": "Joe",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25024,
        "question_text": "Chi è il personaggio principale della serie The Crown?",
        "category": "Serie TV",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45096,
                "answer_text": "Regina Elisabetta II",
                "is_correct": 1
            },
            {
                "answer_id": 45099,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 45098,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 45097,
                "answer_text": "Tyrion",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25030,
        "question_text": "Cosa significa la parola 'cane' in inglese?",
        "category": "Inglese",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45120,
                "answer_text": "dog",
                "is_correct": 1
            },
            {
                "answer_id": 45122,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 45123,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 45121,
                "answer_text": "tree",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25031,
        "question_text": "Cosa significa la parola 'gatto' in inglese?",
        "category": "Inglese",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45125,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 45126,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 45127,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 45124,
                "answer_text": "cat",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 25032,
        "question_text": "Cosa significa la parola 'libro' in inglese?",
        "category": "Inglese",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45129,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 45130,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 45128,
                "answer_text": "book",
                "is_correct": 1
            },
            {
                "answer_id": 45131,
                "answer_text": "water",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25033,
        "question_text": "Cosa significa la parola 'penna' in inglese?",
        "category": "Inglese",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45134,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 45132,
                "answer_text": "pen",
                "is_correct": 1
            },
            {
                "answer_id": 45135,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 45133,
                "answer_text": "tree",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25034,
        "question_text": "Cosa significa la parola 'sole' in inglese?",
        "category": "Inglese",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45139,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 45136,
                "answer_text": "sun",
                "is_correct": 1
            },
            {
                "answer_id": 45138,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 45137,
                "answer_text": "tree",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25035,
        "question_text": "Cosa significa la parola 'luna' in inglese?",
        "category": "Inglese",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45140,
                "answer_text": "moon",
                "is_correct": 1
            },
            {
                "answer_id": 45143,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 45141,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 45142,
                "answer_text": "cloud",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25036,
        "question_text": "Cosa significa la parola 'casa' in inglese?",
        "category": "Inglese",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45146,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 45147,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 45144,
                "answer_text": "house",
                "is_correct": 1
            },
            {
                "answer_id": 45145,
                "answer_text": "tree",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25037,
        "question_text": "Cosa significa la parola 'sedia' in inglese?",
        "category": "Inglese",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45150,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 45148,
                "answer_text": "chair",
                "is_correct": 1
            },
            {
                "answer_id": 45149,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 45151,
                "answer_text": "water",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25038,
        "question_text": "Cosa significa la parola 'scuola' in inglese?",
        "category": "Inglese",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45154,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 45153,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 45155,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 45152,
                "answer_text": "school",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 25039,
        "question_text": "Cosa significa la parola 'strada' in inglese?",
        "category": "Inglese",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45156,
                "answer_text": "street",
                "is_correct": 1
            },
            {
                "answer_id": 45158,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 45157,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 45159,
                "answer_text": "water",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25045,
        "question_text": "Cosa significa l'acronimo 'HTML'?",
        "category": "Informatica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45182,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 45181,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 45183,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            },
            {
                "answer_id": 45180,
                "answer_text": "HyperText Markup Language",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 25046,
        "question_text": "Cosa significa l'acronimo 'CPU'?",
        "category": "Informatica",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45186,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 45185,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 45187,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            },
            {
                "answer_id": 45184,
                "answer_text": "Central Processing Unit",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 25047,
        "question_text": "Cosa significa l'acronimo 'RAM'?",
        "category": "Informatica",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45188,
                "answer_text": "Random Access Memory",
                "is_correct": 1
            },
            {
                "answer_id": 45191,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            },
            {
                "answer_id": 45190,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 45189,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25048,
        "question_text": "Cosa significa l'acronimo 'URL'?",
        "category": "Informatica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45192,
                "answer_text": "Uniform Resource Locator",
                "is_correct": 1
            },
            {
                "answer_id": 45193,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 45194,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 45195,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25049,
        "question_text": "Cosa significa l'acronimo 'API'?",
        "category": "Informatica",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45197,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 45198,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 45196,
                "answer_text": "Application Programming Interface",
                "is_correct": 1
            },
            {
                "answer_id": 45199,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25050,
        "question_text": "Cosa significa l'acronimo 'CSS'?",
        "category": "Informatica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45201,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 45202,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 45200,
                "answer_text": "Cascading Style Sheets",
                "is_correct": 1
            },
            {
                "answer_id": 45203,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25051,
        "question_text": "Cosa significa l'acronimo 'SQL'?",
        "category": "Informatica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45204,
                "answer_text": "Structured Query Language",
                "is_correct": 1
            },
            {
                "answer_id": 45207,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            },
            {
                "answer_id": 45206,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 45205,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25052,
        "question_text": "Cosa significa l'acronimo 'USB'?",
        "category": "Informatica",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45211,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            },
            {
                "answer_id": 45210,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 45209,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 45208,
                "answer_text": "Universal Serial Bus",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 25053,
        "question_text": "Cosa significa l'acronimo 'GPU'?",
        "category": "Informatica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45212,
                "answer_text": "Graphics Processing Unit",
                "is_correct": 1
            },
            {
                "answer_id": 45214,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 45215,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            },
            {
                "answer_id": 45213,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25054,
        "question_text": "Cosa significa l'acronimo 'LAN'?",
        "category": "Informatica",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45219,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            },
            {
                "answer_id": 45218,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 45216,
                "answer_text": "Local Area Network",
                "is_correct": 1
            },
            {
                "answer_id": 45217,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25060,
        "question_text": "Cosa rappresenta il concetto di inflazione?",
        "category": "Economia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45240,
                "answer_text": "aumento dei prezzi",
                "is_correct": 1
            },
            {
                "answer_id": 45243,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 45242,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 45241,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25061,
        "question_text": "Cosa rappresenta il concetto di deflazione?",
        "category": "Economia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45247,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 45245,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 45244,
                "answer_text": "diminuzione dei prezzi",
                "is_correct": 1
            },
            {
                "answer_id": 45246,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25062,
        "question_text": "Cosa rappresenta il concetto di PIL?",
        "category": "Economia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45248,
                "answer_text": "produzione di beni e servizi",
                "is_correct": 1
            },
            {
                "answer_id": 45251,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 45249,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 45250,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25063,
        "question_text": "Cosa rappresenta il concetto di domanda?",
        "category": "Economia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45254,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 45255,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 45253,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 45252,
                "answer_text": "quantità richiesta",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 25064,
        "question_text": "Cosa rappresenta il concetto di offerta?",
        "category": "Economia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45259,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 45258,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 45257,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 45256,
                "answer_text": "quantità offerta",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 25065,
        "question_text": "Cosa rappresenta il concetto di tasso di interesse?",
        "category": "Economia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45262,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 45260,
                "answer_text": "costo del denaro",
                "is_correct": 1
            },
            {
                "answer_id": 45263,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 45261,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25066,
        "question_text": "Cosa rappresenta il concetto di credito?",
        "category": "Economia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45264,
                "answer_text": "prestito concesso",
                "is_correct": 1
            },
            {
                "answer_id": 45267,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 45266,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 45265,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25067,
        "question_text": "Cosa rappresenta il concetto di debito?",
        "category": "Economia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45270,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 45271,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 45268,
                "answer_text": "somma dovuta",
                "is_correct": 1
            },
            {
                "answer_id": 45269,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25068,
        "question_text": "Cosa rappresenta il concetto di investimento?",
        "category": "Economia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45275,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 45272,
                "answer_text": "acquisto di beni produttivi",
                "is_correct": 1
            },
            {
                "answer_id": 45274,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 45273,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25069,
        "question_text": "Cosa rappresenta il concetto di risparmio?",
        "category": "Economia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45279,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 45277,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 45278,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 45276,
                "answer_text": "parte di reddito non spesa",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 25080,
        "question_text": "Chi ha scritto 'L’isola del tesoro'?",
        "category": "Cultura Generale",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45321,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 45323,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 45320,
                "answer_text": "Robert Louis Stevenson",
                "is_correct": 1
            },
            {
                "answer_id": 45322,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25084,
        "question_text": "Chi ha scritto 'Harry Potter'?",
        "category": "Cultura Generale",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45338,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 45339,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 45337,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 45336,
                "answer_text": "J.K. Rowling",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 25010,
        "question_text": "Come si chiama il protagonista di Sword Art Online?",
        "category": "Anime",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45040,
                "answer_text": "Kirito",
                "is_correct": 1
            },
            {
                "answer_id": 45043,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 45041,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 45042,
                "answer_text": "Vegeta",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25011,
        "question_text": "Come si chiama il protagonista di Jujutsu Kaisen?",
        "category": "Anime",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45044,
                "answer_text": "Yuji Itadori",
                "is_correct": 1
            },
            {
                "answer_id": 45045,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 45046,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 45047,
                "answer_text": "Shinji",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25012,
        "question_text": "Come si chiama il protagonista di Black Clover?",
        "category": "Anime",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45051,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 45048,
                "answer_text": "Asta",
                "is_correct": 1
            },
            {
                "answer_id": 45050,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 45049,
                "answer_text": "Sasuke",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25013,
        "question_text": "Come si chiama il protagonista di Fairy Tail?",
        "category": "Anime",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45055,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 45054,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 45052,
                "answer_text": "Natsu Dragneel",
                "is_correct": 1
            },
            {
                "answer_id": 45053,
                "answer_text": "Sasuke",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25014,
        "question_text": "Come si chiama il protagonista di Chainsaw Man?",
        "category": "Anime",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45057,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 45059,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 45056,
                "answer_text": "Denji",
                "is_correct": 1
            },
            {
                "answer_id": 45058,
                "answer_text": "Vegeta",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25025,
        "question_text": "Chi è il personaggio principale della serie Lost?",
        "category": "Serie TV",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45101,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 45100,
                "answer_text": "Jack Shephard",
                "is_correct": 1
            },
            {
                "answer_id": 45103,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 45102,
                "answer_text": "Rick",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25026,
        "question_text": "Chi è il personaggio principale della serie Prison Break?",
        "category": "Serie TV",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45106,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 45105,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 45107,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 45104,
                "answer_text": "Michael Scofield",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 25027,
        "question_text": "Chi è il personaggio principale della serie House M.D.?",
        "category": "Serie TV",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45111,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 45108,
                "answer_text": "Gregory House",
                "is_correct": 1
            },
            {
                "answer_id": 45110,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 45109,
                "answer_text": "Tyrion",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25028,
        "question_text": "Chi è il personaggio principale della serie The Mentalist?",
        "category": "Serie TV",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45113,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 45115,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 45114,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 45112,
                "answer_text": "Patrick Jane",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 25029,
        "question_text": "Chi è il personaggio principale della serie Supernatural?",
        "category": "Serie TV",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45117,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 45116,
                "answer_text": "Dean Winchester",
                "is_correct": 1
            },
            {
                "answer_id": 45118,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 45119,
                "answer_text": "Joe",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25040,
        "question_text": "Cosa significa la parola 'pioggia' in inglese?",
        "category": "Inglese",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45161,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 45162,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 45163,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 45160,
                "answer_text": "rain",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 25041,
        "question_text": "Cosa significa la parola 'neve' in inglese?",
        "category": "Inglese",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45165,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 45164,
                "answer_text": "snow",
                "is_correct": 1
            },
            {
                "answer_id": 45167,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 45166,
                "answer_text": "cloud",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25042,
        "question_text": "Cosa significa la parola 'fuoco' in inglese?",
        "category": "Inglese",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45170,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 45169,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 45168,
                "answer_text": "fire",
                "is_correct": 1
            },
            {
                "answer_id": 45171,
                "answer_text": "water",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25043,
        "question_text": "Cosa significa la parola 'cielo' in inglese?",
        "category": "Inglese",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45174,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 45173,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 45175,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 45172,
                "answer_text": "sky",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 25044,
        "question_text": "Cosa significa la parola 'vento' in inglese?",
        "category": "Inglese",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45176,
                "answer_text": "wind",
                "is_correct": 1
            },
            {
                "answer_id": 45179,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 45178,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 45177,
                "answer_text": "tree",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25055,
        "question_text": "Cosa significa l'acronimo 'BIOS'?",
        "category": "Informatica",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45221,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 45222,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 45223,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            },
            {
                "answer_id": 45220,
                "answer_text": "Basic Input Output System",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 25056,
        "question_text": "Cosa significa l'acronimo 'HTTP'?",
        "category": "Informatica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45225,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 45224,
                "answer_text": "HyperText Transfer Protocol",
                "is_correct": 1
            },
            {
                "answer_id": 45226,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 45227,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25057,
        "question_text": "Cosa significa l'acronimo 'FTP'?",
        "category": "Informatica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45228,
                "answer_text": "File Transfer Protocol",
                "is_correct": 1
            },
            {
                "answer_id": 45231,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            },
            {
                "answer_id": 45229,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 45230,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25058,
        "question_text": "Cosa significa l'acronimo 'VPN'?",
        "category": "Informatica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45235,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            },
            {
                "answer_id": 45232,
                "answer_text": "Virtual Private Network",
                "is_correct": 1
            },
            {
                "answer_id": 45233,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 45234,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25059,
        "question_text": "Cosa significa l'acronimo 'IP'?",
        "category": "Informatica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45239,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            },
            {
                "answer_id": 45238,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 45236,
                "answer_text": "Internet Protocol",
                "is_correct": 1
            },
            {
                "answer_id": 45237,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25070,
        "question_text": "Cosa rappresenta il concetto di mercato?",
        "category": "Economia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45281,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 45282,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 45280,
                "answer_text": "luogo di scambio",
                "is_correct": 1
            },
            {
                "answer_id": 45283,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25071,
        "question_text": "Cosa rappresenta il concetto di moneta?",
        "category": "Economia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45287,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 45284,
                "answer_text": "mezzo di pagamento",
                "is_correct": 1
            },
            {
                "answer_id": 45286,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 45285,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25072,
        "question_text": "Cosa rappresenta il concetto di banca?",
        "category": "Economia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45289,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 45288,
                "answer_text": "intermediario finanziario",
                "is_correct": 1
            },
            {
                "answer_id": 45290,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 45291,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25073,
        "question_text": "Cosa rappresenta il concetto di tasse?",
        "category": "Economia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45293,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 45292,
                "answer_text": "obblighi verso lo stato",
                "is_correct": 1
            },
            {
                "answer_id": 45295,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 45294,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25074,
        "question_text": "Cosa rappresenta il concetto di credito al consumo?",
        "category": "Economia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45297,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 45299,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 45298,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 45296,
                "answer_text": "prestito per beni di uso",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 25086,
        "question_text": "Chi ha scritto 'Il Codice da Vinci'?",
        "category": "Cultura Generale",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45347,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 45345,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 45346,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 45344,
                "answer_text": "Dan Brown",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 25088,
        "question_text": "Chi ha scritto 'L'amica geniale'?",
        "category": "Cultura Generale",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45355,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 45354,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 45353,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 45352,
                "answer_text": "Elena Ferrante",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 25089,
        "question_text": "Chi ha scritto 'La solitudine dei numeri primi'?",
        "category": "Cultura Generale",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45359,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 45357,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 45356,
                "answer_text": "Paolo Giordano",
                "is_correct": 1
            },
            {
                "answer_id": 45358,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25090,
        "question_text": "Qual è la funzione dei mitocondri?",
        "category": "Biologia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45362,
                "answer_text": "Digestione cellulare",
                "is_correct": 0
            },
            {
                "answer_id": 45360,
                "answer_text": "Produzione di energia",
                "is_correct": 1
            },
            {
                "answer_id": 45361,
                "answer_text": "Sintesi proteica",
                "is_correct": 0
            },
            {
                "answer_id": 45363,
                "answer_text": "Formazione del DNA",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25091,
        "question_text": "Cosa trasporta l'emoglobina?",
        "category": "Biologia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45366,
                "answer_text": "Zuccheri",
                "is_correct": 0
            },
            {
                "answer_id": 45365,
                "answer_text": "Anidride carbonica",
                "is_correct": 0
            },
            {
                "answer_id": 45364,
                "answer_text": "Ossigeno",
                "is_correct": 1
            },
            {
                "answer_id": 45367,
                "answer_text": "Proteine",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25092,
        "question_text": "Dove avviene la fotosintesi?",
        "category": "Biologia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45369,
                "answer_text": "Nucleo",
                "is_correct": 0
            },
            {
                "answer_id": 45368,
                "answer_text": "Cloroplasti",
                "is_correct": 1
            },
            {
                "answer_id": 45371,
                "answer_text": "Ribosoma",
                "is_correct": 0
            },
            {
                "answer_id": 45370,
                "answer_text": "Mitocondrio",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25093,
        "question_text": "Qual è l'unità di misura della forza?",
        "category": "Fisica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45372,
                "answer_text": "Newton",
                "is_correct": 1
            },
            {
                "answer_id": 45375,
                "answer_text": "Joule",
                "is_correct": 0
            },
            {
                "answer_id": 45374,
                "answer_text": "Pascal",
                "is_correct": 0
            },
            {
                "answer_id": 45373,
                "answer_text": "Watt",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25094,
        "question_text": "Cosa afferma la seconda legge della dinamica?",
        "category": "Fisica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45378,
                "answer_text": "P=VI",
                "is_correct": 0
            },
            {
                "answer_id": 45376,
                "answer_text": "F=ma",
                "is_correct": 1
            },
            {
                "answer_id": 45379,
                "answer_text": "a=v/t",
                "is_correct": 0
            },
            {
                "answer_id": 45377,
                "answer_text": "E=mc²",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25095,
        "question_text": "Che cos'è la velocità?",
        "category": "Fisica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45382,
                "answer_text": "Energia fratto tempo",
                "is_correct": 0
            },
            {
                "answer_id": 45380,
                "answer_text": "Spazio fratto tempo",
                "is_correct": 1
            },
            {
                "answer_id": 45383,
                "answer_text": "Potenza per tempo",
                "is_correct": 0
            },
            {
                "answer_id": 45381,
                "answer_text": "Forza fratto massa",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25096,
        "question_text": "Qual è il simbolo dell'acqua?",
        "category": "Chimica",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45386,
                "answer_text": "CO2",
                "is_correct": 0
            },
            {
                "answer_id": 45387,
                "answer_text": "H2O2",
                "is_correct": 0
            },
            {
                "answer_id": 45385,
                "answer_text": "O2",
                "is_correct": 0
            },
            {
                "answer_id": 45384,
                "answer_text": "H2O",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 25097,
        "question_text": "Quale particella ha carica positiva?",
        "category": "Chimica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45391,
                "answer_text": "Ione",
                "is_correct": 0
            },
            {
                "answer_id": 45389,
                "answer_text": "Neutrone",
                "is_correct": 0
            },
            {
                "answer_id": 45388,
                "answer_text": "Protone",
                "is_correct": 1
            },
            {
                "answer_id": 45390,
                "answer_text": "Elettrone",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25099,
        "question_text": "Cosa misura un estensimetro?",
        "category": "Ingegneria",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45399,
                "answer_text": "Frequenza",
                "is_correct": 0
            },
            {
                "answer_id": 45396,
                "answer_text": "Deformazione",
                "is_correct": 1
            },
            {
                "answer_id": 45397,
                "answer_text": "Temperatura",
                "is_correct": 0
            },
            {
                "answer_id": 45398,
                "answer_text": "Velocità",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25100,
        "question_text": "Cos'è una trave isostatica?",
        "category": "Ingegneria",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45403,
                "answer_text": "Nodo indeformabile",
                "is_correct": 0
            },
            {
                "answer_id": 45400,
                "answer_text": "Sistema staticamente determinato",
                "is_correct": 1
            },
            {
                "answer_id": 45401,
                "answer_text": "Sistema instabile",
                "is_correct": 0
            },
            {
                "answer_id": 45402,
                "answer_text": "Struttura complessa",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25101,
        "question_text": "Qual è l’unità di misura della pressione?",
        "category": "Ingegneria",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45406,
                "answer_text": "Ampere",
                "is_correct": 0
            },
            {
                "answer_id": 45407,
                "answer_text": "Tesla",
                "is_correct": 0
            },
            {
                "answer_id": 45405,
                "answer_text": "Joule",
                "is_correct": 0
            },
            {
                "answer_id": 45404,
                "answer_text": "Pascal",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 25102,
        "question_text": "Cosa tutela il diritto penale?",
        "category": "Giurisprudenza",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 45408,
                "answer_text": "Ordine pubblico",
                "is_correct": 1
            },
            {
                "answer_id": 45411,
                "answer_text": "Norme fiscali",
                "is_correct": 0
            },
            {
                "answer_id": 45410,
                "answer_text": "Contratti privati",
                "is_correct": 0
            },
            {
                "answer_id": 45409,
                "answer_text": "Rapporti familiari",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25103,
        "question_text": "Che cos'è un contratto?",
        "category": "Giurisprudenza",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45415,
                "answer_text": "Atto unilaterale",
                "is_correct": 0
            },
            {
                "answer_id": 45412,
                "answer_text": "Accordo tra due o più parti",
                "is_correct": 1
            },
            {
                "answer_id": 45413,
                "answer_text": "Sentenza giudiziaria",
                "is_correct": 0
            },
            {
                "answer_id": 45414,
                "answer_text": "Proposta normativa",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25104,
        "question_text": "Cosa fa un avvocato?",
        "category": "Giurisprudenza",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45418,
                "answer_text": "Redige sentenze",
                "is_correct": 0
            },
            {
                "answer_id": 45416,
                "answer_text": "Rappresenta legalmente un cliente",
                "is_correct": 1
            },
            {
                "answer_id": 45419,
                "answer_text": "Legifera",
                "is_correct": 0
            },
            {
                "answer_id": 45417,
                "answer_text": "Esegue arresti",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25105,
        "question_text": "Cos’è il condizionamento classico?",
        "category": "Psicologia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45420,
                "answer_text": "Apprendimento per associazione",
                "is_correct": 1
            },
            {
                "answer_id": 45423,
                "answer_text": "Riflessione razionale",
                "is_correct": 0
            },
            {
                "answer_id": 45422,
                "answer_text": "Memoria a lungo termine",
                "is_correct": 0
            },
            {
                "answer_id": 45421,
                "answer_text": "Risposta automatica",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25106,
        "question_text": "Chi ha teorizzato l'inconscio?",
        "category": "Psicologia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 45425,
                "answer_text": "Skinner",
                "is_correct": 0
            },
            {
                "answer_id": 45427,
                "answer_text": "Maslow",
                "is_correct": 0
            },
            {
                "answer_id": 45424,
                "answer_text": "Freud",
                "is_correct": 1
            },
            {
                "answer_id": 45426,
                "answer_text": "Jung",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 25107,
        "question_text": "Cos'è la memoria a breve termine?",
        "category": "Psicologia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 45429,
                "answer_text": "Archivio permanente",
                "is_correct": 0
            },
            {
                "answer_id": 45428,
                "answer_text": "Sistema temporaneo di memorizzazione",
                "is_correct": 1
            },
            {
                "answer_id": 45430,
                "answer_text": "Reazione emotiva",
                "is_correct": 0
            },
            {
                "answer_id": 45431,
                "answer_text": "Percezione visiva",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 26000,
        "question_text": "Come si chiama il protagonista di Mob Psycho 100?",
        "category": "Anime",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 47000,
                "answer_text": "Mob",
                "is_correct": 1
            },
            {
                "answer_id": 47002,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 47001,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 47003,
                "answer_text": "Shinji",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 26001,
        "question_text": "Come si chiama il protagonista di The Seven Deadly Sins?",
        "category": "Anime",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 47006,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 47005,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 47004,
                "answer_text": "Meliodas",
                "is_correct": 1
            },
            {
                "answer_id": 47007,
                "answer_text": "Shinji",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 26002,
        "question_text": "Come si chiama il protagonista di Blue Lock?",
        "category": "Anime",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 47010,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 47011,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 47008,
                "answer_text": "Yoichi Isagi",
                "is_correct": 1
            },
            {
                "answer_id": 47009,
                "answer_text": "Sasuke",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 26003,
        "question_text": "Come si chiama il protagonista di Vinland Saga?",
        "category": "Anime",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 47014,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 47015,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 47013,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 47012,
                "answer_text": "Thorfinn",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 26004,
        "question_text": "Come si chiama il protagonista di Dr. Stone?",
        "category": "Anime",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 47018,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 47016,
                "answer_text": "Senku Ishigami",
                "is_correct": 1
            },
            {
                "answer_id": 47017,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 47019,
                "answer_text": "Shinji",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 26005,
        "question_text": "Chi è il personaggio principale della serie The Boys?",
        "category": "Serie TV",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 47020,
                "answer_text": "Billy Butcher",
                "is_correct": 1
            },
            {
                "answer_id": 47022,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 47023,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 47021,
                "answer_text": "Tyrion",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 26006,
        "question_text": "Chi è il personaggio principale della serie You?",
        "category": "Serie TV",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 47024,
                "answer_text": "Joe Goldberg",
                "is_correct": 1
            },
            {
                "answer_id": 47025,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 47027,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 47026,
                "answer_text": "Rick",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 26007,
        "question_text": "Chi è il personaggio principale della serie Peaky Blinders?",
        "category": "Serie TV",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 47031,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 47030,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 47028,
                "answer_text": "Thomas Shelby",
                "is_correct": 1
            },
            {
                "answer_id": 47029,
                "answer_text": "Tyrion",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 26008,
        "question_text": "Chi è il personaggio principale della serie Wednesday?",
        "category": "Serie TV",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 47033,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 47035,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 47032,
                "answer_text": "Wednesday Addams",
                "is_correct": 1
            },
            {
                "answer_id": 47034,
                "answer_text": "Rick",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 26009,
        "question_text": "Chi è il personaggio principale della serie Euphoria?",
        "category": "Serie TV",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 47039,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 47038,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 47037,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 47036,
                "answer_text": "Rue Bennett",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 26010,
        "question_text": "Cosa significa la parola 'bicicletta' in inglese?",
        "category": "Inglese",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 47040,
                "answer_text": "bicycle",
                "is_correct": 1
            },
            {
                "answer_id": 47042,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 47043,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 47041,
                "answer_text": "tree",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 26011,
        "question_text": "Cosa significa la parola 'telefono' in inglese?",
        "category": "Inglese",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 47045,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 47046,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 47044,
                "answer_text": "phone",
                "is_correct": 1
            },
            {
                "answer_id": 47047,
                "answer_text": "water",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 26012,
        "question_text": "Cosa significa la parola 'occhiali' in inglese?",
        "category": "Inglese",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 47049,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 47048,
                "answer_text": "glasses",
                "is_correct": 1
            },
            {
                "answer_id": 47050,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 47051,
                "answer_text": "water",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 26013,
        "question_text": "Cosa significa la parola 'finestra' in inglese?",
        "category": "Inglese",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 47054,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 47053,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 47052,
                "answer_text": "window",
                "is_correct": 1
            },
            {
                "answer_id": 47055,
                "answer_text": "water",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 26014,
        "question_text": "Cosa significa la parola 'porta' in inglese?",
        "category": "Inglese",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 47057,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 47058,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 47059,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 47056,
                "answer_text": "door",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 26015,
        "question_text": "Cosa significa l'acronimo 'DNS'?",
        "category": "Informatica",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 47060,
                "answer_text": "Domain Name System",
                "is_correct": 1
            },
            {
                "answer_id": 47062,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 47061,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 47063,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 26016,
        "question_text": "Cosa significa l'acronimo 'IoT'?",
        "category": "Informatica",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 47067,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            },
            {
                "answer_id": 47065,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 47066,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 47064,
                "answer_text": "Internet of Things",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 26017,
        "question_text": "Cosa significa l'acronimo 'AI'?",
        "category": "Informatica",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 47070,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 47069,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 47068,
                "answer_text": "Artificial Intelligence",
                "is_correct": 1
            },
            {
                "answer_id": 47071,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 26018,
        "question_text": "Cosa significa l'acronimo 'ML'?",
        "category": "Informatica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 47074,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 47072,
                "answer_text": "Machine Learning",
                "is_correct": 1
            },
            {
                "answer_id": 47073,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 47075,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 26019,
        "question_text": "Cosa significa l'acronimo 'CLI'?",
        "category": "Informatica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 47077,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 47076,
                "answer_text": "Command Line Interface",
                "is_correct": 1
            },
            {
                "answer_id": 47078,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 47079,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 26020,
        "question_text": "Cosa rappresenta il concetto di spread?",
        "category": "Economia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 47080,
                "answer_text": "differenza tra titoli di stato",
                "is_correct": 1
            },
            {
                "answer_id": 47082,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 47081,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 47083,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 26021,
        "question_text": "Cosa rappresenta il concetto di default?",
        "category": "Economia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 47085,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 47086,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 47087,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 47084,
                "answer_text": "incapacità di pagare i debiti",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 26022,
        "question_text": "Cosa rappresenta il concetto di derivato?",
        "category": "Economia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 47089,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 47090,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 47091,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 47088,
                "answer_text": "strumento finanziario complesso",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 26023,
        "question_text": "Cosa rappresenta il concetto di liquidità?",
        "category": "Economia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 47092,
                "answer_text": "capacità di convertire in contante",
                "is_correct": 1
            },
            {
                "answer_id": 47093,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 47095,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 47094,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 26024,
        "question_text": "Cosa rappresenta il concetto di bolla speculativa?",
        "category": "Economia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 47096,
                "answer_text": "aumento eccessivo dei prezzi",
                "is_correct": 1
            },
            {
                "answer_id": 47098,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 47097,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 47099,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 26025,
        "question_text": "Chi ha scritto 'La Metamorfosi'?",
        "category": "Cultura Generale",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 47101,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 47100,
                "answer_text": "Franz Kafka",
                "is_correct": 1
            },
            {
                "answer_id": 47103,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 47102,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 26027,
        "question_text": "Chi ha scritto 'Il signore degli anelli'?",
        "category": "Cultura Generale",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 47110,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 47109,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 47111,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 47108,
                "answer_text": "J.R.R. Tolkien",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 26028,
        "question_text": "Chi ha scritto 'La Storia'?",
        "category": "Cultura Generale",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 47112,
                "answer_text": "Elsa Morante",
                "is_correct": 1
            },
            {
                "answer_id": 47113,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 47114,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 47115,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 27000,
        "question_text": "Come si chiama il protagonista di Parasyte?",
        "category": "Anime",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 49003,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 49002,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 49001,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 49000,
                "answer_text": "Shinichi Izumi",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 27001,
        "question_text": "Come si chiama il protagonista di Re:Zero?",
        "category": "Anime",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 49005,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 49006,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 49004,
                "answer_text": "Subaru Natsuki",
                "is_correct": 1
            },
            {
                "answer_id": 49007,
                "answer_text": "Shinji",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 27002,
        "question_text": "Come si chiama il protagonista di Erased?",
        "category": "Anime",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 49009,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 49010,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 49011,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 49008,
                "answer_text": "Satoru Fujinuma",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 27003,
        "question_text": "Come si chiama il protagonista di The Promised Neverland?",
        "category": "Anime",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 49013,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 49012,
                "answer_text": "Emma",
                "is_correct": 1
            },
            {
                "answer_id": 49014,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 49015,
                "answer_text": "Shinji",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 27004,
        "question_text": "Come si chiama il protagonista di Dorohedoro?",
        "category": "Anime",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 49019,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 49016,
                "answer_text": "Caiman",
                "is_correct": 1
            },
            {
                "answer_id": 49018,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 49017,
                "answer_text": "Sasuke",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 27005,
        "question_text": "Chi è il personaggio principale della serie Dark?",
        "category": "Serie TV",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 49020,
                "answer_text": "Jonas Kahnwald",
                "is_correct": 1
            },
            {
                "answer_id": 49022,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 49023,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 49021,
                "answer_text": "Tyrion",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 27006,
        "question_text": "Chi è il personaggio principale della serie The Witcher?",
        "category": "Serie TV",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 49025,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 49026,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 49027,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 49024,
                "answer_text": "Geralt di Rivia",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 27007,
        "question_text": "Chi è il personaggio principale della serie The Mandalorian?",
        "category": "Serie TV",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 49030,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 49028,
                "answer_text": "Din Djarin",
                "is_correct": 1
            },
            {
                "answer_id": 49029,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 49031,
                "answer_text": "Joe",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 27008,
        "question_text": "Chi è il personaggio principale della serie Squid Game?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 49033,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 49035,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 49032,
                "answer_text": "Seong Gi-hun",
                "is_correct": 1
            },
            {
                "answer_id": 49034,
                "answer_text": "Rick",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 27009,
        "question_text": "Chi è il personaggio principale della serie Money Heist?",
        "category": "Serie TV",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 49037,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 49038,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 49039,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 49036,
                "answer_text": "Il Professore",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 27010,
        "question_text": "Cosa significa la parola 'macchina' in inglese?",
        "category": "Inglese",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 49040,
                "answer_text": "car",
                "is_correct": 1
            },
            {
                "answer_id": 49043,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 49041,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 49042,
                "answer_text": "cloud",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 27011,
        "question_text": "Cosa significa la parola 'aereo' in inglese?",
        "category": "Inglese",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 49046,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 49045,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 49047,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 49044,
                "answer_text": "airplane",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 27012,
        "question_text": "Cosa significa la parola 'nave' in inglese?",
        "category": "Inglese",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 49050,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 49051,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 49049,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 49048,
                "answer_text": "ship",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 27013,
        "question_text": "Cosa significa la parola 'camicia' in inglese?",
        "category": "Inglese",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 49052,
                "answer_text": "shirt",
                "is_correct": 1
            },
            {
                "answer_id": 49053,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 49054,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 49055,
                "answer_text": "water",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 27014,
        "question_text": "Cosa significa la parola 'giacca' in inglese?",
        "category": "Inglese",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 49059,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 49056,
                "answer_text": "jacket",
                "is_correct": 1
            },
            {
                "answer_id": 49057,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 49058,
                "answer_text": "cloud",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 27015,
        "question_text": "Cosa significa l'acronimo 'HTTPS'?",
        "category": "Informatica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 49060,
                "answer_text": "HyperText Transfer Protocol Secure",
                "is_correct": 1
            },
            {
                "answer_id": 49062,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 49063,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            },
            {
                "answer_id": 49061,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 27016,
        "question_text": "Cosa significa l'acronimo 'PDF'?",
        "category": "Informatica",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 49064,
                "answer_text": "Portable Document Format",
                "is_correct": 1
            },
            {
                "answer_id": 49067,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            },
            {
                "answer_id": 49066,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 49065,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 27017,
        "question_text": "Cosa significa l'acronimo 'PNG'?",
        "category": "Informatica",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 49071,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            },
            {
                "answer_id": 49069,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 49068,
                "answer_text": "Portable Network Graphics",
                "is_correct": 1
            },
            {
                "answer_id": 49070,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 27018,
        "question_text": "Cosa significa l'acronimo 'GIF'?",
        "category": "Informatica",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 49073,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 49074,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 49072,
                "answer_text": "Graphics Interchange Format",
                "is_correct": 1
            },
            {
                "answer_id": 49075,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 27019,
        "question_text": "Cosa rappresenta il concetto di bilancio?",
        "category": "Economia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 49079,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 49076,
                "answer_text": "documento contabile",
                "is_correct": 1
            },
            {
                "answer_id": 49078,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 49077,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 27020,
        "question_text": "Cosa rappresenta il concetto di dividendo?",
        "category": "Economia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 49081,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 49080,
                "answer_text": "parte di utili distribuiti",
                "is_correct": 1
            },
            {
                "answer_id": 49083,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 49082,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 27021,
        "question_text": "Cosa rappresenta il concetto di azioni?",
        "category": "Economia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 49086,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 49084,
                "answer_text": "quote di proprietà",
                "is_correct": 1
            },
            {
                "answer_id": 49085,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 49087,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 27022,
        "question_text": "Cosa rappresenta il concetto di mercato secondario?",
        "category": "Economia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 49090,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 49088,
                "answer_text": "compravendita di titoli già emessi",
                "is_correct": 1
            },
            {
                "answer_id": 49091,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 49089,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 27023,
        "question_text": "Cosa rappresenta il concetto di obbligazione?",
        "category": "Economia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 49095,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 49092,
                "answer_text": "titolo di debito",
                "is_correct": 1
            },
            {
                "answer_id": 49094,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 49093,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 27025,
        "question_text": "Chi ha scritto 'Le avventure di Huckleberry Finn'?",
        "category": "Cultura Generale",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 49101,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 49100,
                "answer_text": "Mark Twain",
                "is_correct": 1
            },
            {
                "answer_id": 49102,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 49103,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 27026,
        "question_text": "Chi ha scritto 'Il maestro e Margherita'?",
        "category": "Cultura Generale",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 49105,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 49106,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 49104,
                "answer_text": "Michail Bulgakov",
                "is_correct": 1
            },
            {
                "answer_id": 49107,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 28000,
        "question_text": "Come si chiama il protagonista di Made in Abyss?",
        "category": "Anime",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 51002,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 51003,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 51000,
                "answer_text": "Riko",
                "is_correct": 1
            },
            {
                "answer_id": 51001,
                "answer_text": "Sasuke",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 28001,
        "question_text": "Come si chiama il protagonista di Berserk?",
        "category": "Anime",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 51006,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 51004,
                "answer_text": "Guts",
                "is_correct": 1
            },
            {
                "answer_id": 51007,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 51005,
                "answer_text": "Sasuke",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 28002,
        "question_text": "Come si chiama il protagonista di Akira?",
        "category": "Anime",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 51011,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 51009,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 51010,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 51008,
                "answer_text": "Kaneda",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 28003,
        "question_text": "Come si chiama il protagonista di Devilman Crybaby?",
        "category": "Anime",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 51015,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 51014,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 51012,
                "answer_text": "Akira Fudo",
                "is_correct": 1
            },
            {
                "answer_id": 51013,
                "answer_text": "Sasuke",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 28004,
        "question_text": "Come si chiama il protagonista di Samurai Champloo?",
        "category": "Anime",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 51018,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 51016,
                "answer_text": "Mugen",
                "is_correct": 1
            },
            {
                "answer_id": 51017,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 51019,
                "answer_text": "Shinji",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 28005,
        "question_text": "Chi è il personaggio principale della serie The Leftovers?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 51021,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 51022,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 51023,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 51020,
                "answer_text": "Kevin Garvey",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 28006,
        "question_text": "Chi è il personaggio principale della serie Mindhunter?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 51026,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 51024,
                "answer_text": "Holden Ford",
                "is_correct": 1
            },
            {
                "answer_id": 51027,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 51025,
                "answer_text": "Tyrion",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 28007,
        "question_text": "Chi è il personaggio principale della serie The OA?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 51031,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 51028,
                "answer_text": "Prairie Johnson",
                "is_correct": 1
            },
            {
                "answer_id": 51029,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 51030,
                "answer_text": "Rick",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 28008,
        "question_text": "Chi è il personaggio principale della serie Russian Doll?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 51035,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 51032,
                "answer_text": "Nadia Vulvokov",
                "is_correct": 1
            },
            {
                "answer_id": 51034,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 51033,
                "answer_text": "Tyrion",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 28009,
        "question_text": "Chi è il personaggio principale della serie True Detective?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 51036,
                "answer_text": "Rust Cohle",
                "is_correct": 1
            },
            {
                "answer_id": 51037,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 51038,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 51039,
                "answer_text": "Joe",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 28010,
        "question_text": "Cosa significa la parola 'tempo' in inglese?",
        "category": "Inglese",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 51042,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 51040,
                "answer_text": "weather",
                "is_correct": 1
            },
            {
                "answer_id": 51041,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 51043,
                "answer_text": "water",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 28011,
        "question_text": "Cosa significa la parola 'cibo' in inglese?",
        "category": "Inglese",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 51046,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 51047,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 51044,
                "answer_text": "food",
                "is_correct": 1
            },
            {
                "answer_id": 51045,
                "answer_text": "tree",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 28012,
        "question_text": "Cosa significa la parola 'bevanda' in inglese?",
        "category": "Inglese",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 51050,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 51051,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 51049,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 51048,
                "answer_text": "drink",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 28013,
        "question_text": "Cosa significa la parola 'mare' in inglese?",
        "category": "Inglese",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 51055,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 51052,
                "answer_text": "sea",
                "is_correct": 1
            },
            {
                "answer_id": 51054,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 51053,
                "answer_text": "tree",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 28014,
        "question_text": "Cosa significa la parola 'montagna' in inglese?",
        "category": "Inglese",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 51057,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 51056,
                "answer_text": "mountain",
                "is_correct": 1
            },
            {
                "answer_id": 51059,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 51058,
                "answer_text": "cloud",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 28015,
        "question_text": "Cosa significa l'acronimo 'JSON'?",
        "category": "Informatica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 51061,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 51062,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 51060,
                "answer_text": "JavaScript Object Notation",
                "is_correct": 1
            },
            {
                "answer_id": 51063,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 28016,
        "question_text": "Cosa significa l'acronimo 'SEO'?",
        "category": "Informatica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 51065,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 51067,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            },
            {
                "answer_id": 51064,
                "answer_text": "Search Engine Optimization",
                "is_correct": 1
            },
            {
                "answer_id": 51066,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 28017,
        "question_text": "Cosa significa l'acronimo 'IDE'?",
        "category": "Informatica",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 51071,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            },
            {
                "answer_id": 51070,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 51068,
                "answer_text": "Integrated Development Environment",
                "is_correct": 1
            },
            {
                "answer_id": 51069,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 28018,
        "question_text": "Cosa rappresenta il concetto di utile?",
        "category": "Economia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 51075,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 51074,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 51073,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 51072,
                "answer_text": "profitto di un'azienda",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 28019,
        "question_text": "Cosa rappresenta il concetto di capitale?",
        "category": "Economia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 51079,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 51076,
                "answer_text": "risorse finanziarie",
                "is_correct": 1
            },
            {
                "answer_id": 51078,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 51077,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 28020,
        "question_text": "Cosa rappresenta il concetto di budget?",
        "category": "Economia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 51080,
                "answer_text": "piano di spesa",
                "is_correct": 1
            },
            {
                "answer_id": 51083,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 51081,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 51082,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 28021,
        "question_text": "Cosa rappresenta il concetto di patrimonio?",
        "category": "Economia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 51084,
                "answer_text": "insieme di beni",
                "is_correct": 1
            },
            {
                "answer_id": 51087,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 51086,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 51085,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 28022,
        "question_text": "Cosa rappresenta il concetto di reddito?",
        "category": "Economia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 51089,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 51091,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 51090,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 51088,
                "answer_text": "entrata economica",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 28023,
        "question_text": "Chi ha scritto 'Il vecchio e il mare'?",
        "category": "Cultura Generale",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 51095,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 51092,
                "answer_text": "Ernest Hemingway",
                "is_correct": 1
            },
            {
                "answer_id": 51093,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 51094,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 28025,
        "question_text": "Chi ha scritto 'La camera azzurra'?",
        "category": "Cultura Generale",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 51100,
                "answer_text": "Georges Simenon",
                "is_correct": 1
            },
            {
                "answer_id": 51101,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 51103,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 51102,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 28026,
        "question_text": "Chi ha scritto 'Il castello'?",
        "category": "Cultura Generale",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 51106,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 51105,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 51104,
                "answer_text": "Franz Kafka",
                "is_correct": 1
            },
            {
                "answer_id": 51107,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 29000,
        "question_text": "Come si chiama il protagonista di Code Geass?",
        "category": "Anime",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 53001,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 53000,
                "answer_text": "Lelouch Lamperouge",
                "is_correct": 1
            },
            {
                "answer_id": 53003,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 53002,
                "answer_text": "Vegeta",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 29001,
        "question_text": "Come si chiama il protagonista di Steins;Gate?",
        "category": "Anime",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 53005,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 53004,
                "answer_text": "Rintarou Okabe",
                "is_correct": 1
            },
            {
                "answer_id": 53006,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 53007,
                "answer_text": "Shinji",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 29002,
        "question_text": "Come si chiama il protagonista di No Game No Life?",
        "category": "Anime",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 53011,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 53010,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 53008,
                "answer_text": "Sora",
                "is_correct": 1
            },
            {
                "answer_id": 53009,
                "answer_text": "Sasuke",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 29003,
        "question_text": "Come si chiama il protagonista di Toradora!?",
        "category": "Anime",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 53014,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 53013,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 53015,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 53012,
                "answer_text": "Ryuuji Takasu",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 29004,
        "question_text": "Come si chiama il protagonista di Clannad?",
        "category": "Anime",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 53017,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 53016,
                "answer_text": "Tomoya Okazaki",
                "is_correct": 1
            },
            {
                "answer_id": 53019,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 53018,
                "answer_text": "Vegeta",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 29005,
        "question_text": "Chi è il personaggio principale della serie Mr. Robot?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 53022,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 53020,
                "answer_text": "Elliot Alderson",
                "is_correct": 1
            },
            {
                "answer_id": 53021,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 53023,
                "answer_text": "Joe",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 29006,
        "question_text": "Chi è il personaggio principale della serie Fleabag?",
        "category": "Serie TV",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 53025,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 53027,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 53026,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 53024,
                "answer_text": "Fleabag",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 29007,
        "question_text": "Chi è il personaggio principale della serie Barry?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 53029,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 53028,
                "answer_text": "Barry Berkman",
                "is_correct": 1
            },
            {
                "answer_id": 53030,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 53031,
                "answer_text": "Joe",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 29008,
        "question_text": "Chi è il personaggio principale della serie The Good Place?",
        "category": "Serie TV",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 53035,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 53034,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 53032,
                "answer_text": "Eleanor Shellstrop",
                "is_correct": 1
            },
            {
                "answer_id": 53033,
                "answer_text": "Tyrion",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 29009,
        "question_text": "Chi è il personaggio principale della serie Succession?",
        "category": "Serie TV",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 53036,
                "answer_text": "Kendall Roy",
                "is_correct": 1
            },
            {
                "answer_id": 53039,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 53038,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 53037,
                "answer_text": "Tyrion",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 29010,
        "question_text": "Cosa significa la parola 'letto' in inglese?",
        "category": "Inglese",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 53042,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 53041,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 53043,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 53040,
                "answer_text": "bed",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 29011,
        "question_text": "Cosa significa la parola 'tavolo' in inglese?",
        "category": "Inglese",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 53045,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 53047,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 53046,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 53044,
                "answer_text": "table",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 29012,
        "question_text": "Cosa significa la parola 'scarpe' in inglese?",
        "category": "Inglese",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 53051,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 53048,
                "answer_text": "shoes",
                "is_correct": 1
            },
            {
                "answer_id": 53050,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 53049,
                "answer_text": "tree",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 29013,
        "question_text": "Cosa significa la parola 'lampada' in inglese?",
        "category": "Inglese",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 53052,
                "answer_text": "lamp",
                "is_correct": 1
            },
            {
                "answer_id": 53055,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 53053,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 53054,
                "answer_text": "cloud",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 29014,
        "question_text": "Cosa significa la parola 'valigia' in inglese?",
        "category": "Inglese",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 53057,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 53059,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 53056,
                "answer_text": "suitcase",
                "is_correct": 1
            },
            {
                "answer_id": 53058,
                "answer_text": "cloud",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 29015,
        "question_text": "Cosa significa l'acronimo 'SSD'?",
        "category": "Informatica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 53061,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 53063,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            },
            {
                "answer_id": 53062,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 53060,
                "answer_text": "Solid State Drive",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 29016,
        "question_text": "Cosa significa l'acronimo 'SMTP'?",
        "category": "Informatica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 53066,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 53065,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 53064,
                "answer_text": "Simple Mail Transfer Protocol",
                "is_correct": 1
            },
            {
                "answer_id": 53067,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 29017,
        "question_text": "Cosa significa l'acronimo 'SSH'?",
        "category": "Informatica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 53069,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 53070,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 53068,
                "answer_text": "Secure Shell",
                "is_correct": 1
            },
            {
                "answer_id": 53071,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 29018,
        "question_text": "Cosa significa l'acronimo 'ASCII'?",
        "category": "Informatica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 53073,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 53075,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            },
            {
                "answer_id": 53074,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 53072,
                "answer_text": "American Standard Code for Information Interchange",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 29019,
        "question_text": "Cosa rappresenta il concetto di rischio?",
        "category": "Economia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 53076,
                "answer_text": "possibilità di perdita",
                "is_correct": 1
            },
            {
                "answer_id": 53077,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 53079,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 53078,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 29020,
        "question_text": "Cosa rappresenta il concetto di interesse composto?",
        "category": "Economia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 53082,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 53080,
                "answer_text": "interesse su interesse",
                "is_correct": 1
            },
            {
                "answer_id": 53083,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 53081,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 29021,
        "question_text": "Cosa rappresenta il concetto di tasso fisso?",
        "category": "Economia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 53086,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 53084,
                "answer_text": "interesse invariabile",
                "is_correct": 1
            },
            {
                "answer_id": 53087,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 53085,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 29022,
        "question_text": "Cosa rappresenta il concetto di tasso variabile?",
        "category": "Economia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 53090,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 53089,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 53091,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 53088,
                "answer_text": "interesse che cambia nel tempo",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 29023,
        "question_text": "Cosa rappresenta il concetto di fondo comune?",
        "category": "Economia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 53095,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 53093,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 53094,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 53092,
                "answer_text": "portafoglio collettivo di investimenti",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 29024,
        "question_text": "Chi ha scritto 'Cent'anni di solitudine'?",
        "category": "Cultura Generale",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 53096,
                "answer_text": "Gabriel García Márquez",
                "is_correct": 1
            },
            {
                "answer_id": 53098,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 53097,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 53099,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 29025,
        "question_text": "Chi ha scritto 'Il processo'?",
        "category": "Cultura Generale",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 53102,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 53103,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 53100,
                "answer_text": "Franz Kafka",
                "is_correct": 1
            },
            {
                "answer_id": 53101,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 29026,
        "question_text": "Chi ha scritto 'Il fu Mattia Pascal'?",
        "category": "Cultura Generale",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 53105,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 53107,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 53106,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 53104,
                "answer_text": "Luigi Pirandello",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 29027,
        "question_text": "Chi ha scritto 'Uno, nessuno e centomila'?",
        "category": "Cultura Generale",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 53110,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 53111,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 53108,
                "answer_text": "Luigi Pirandello",
                "is_correct": 1
            },
            {
                "answer_id": 53109,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 30000,
        "question_text": "Come si chiama il protagonista di Zankyou no Terror?",
        "category": "Anime",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 55001,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 55002,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 55003,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 55000,
                "answer_text": "Nine",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 30001,
        "question_text": "Come si chiama il protagonista di Gurren Lagann?",
        "category": "Anime",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 55005,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 55004,
                "answer_text": "Simon",
                "is_correct": 1
            },
            {
                "answer_id": 55006,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 55007,
                "answer_text": "Shinji",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 30002,
        "question_text": "Come si chiama il protagonista di Elfen Lied?",
        "category": "Anime",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 55010,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 55008,
                "answer_text": "Lucy",
                "is_correct": 1
            },
            {
                "answer_id": 55011,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 55009,
                "answer_text": "Sasuke",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 30003,
        "question_text": "Come si chiama il protagonista di Bakuman?",
        "category": "Anime",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 55012,
                "answer_text": "Moritaka Mashiro",
                "is_correct": 1
            },
            {
                "answer_id": 55015,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 55013,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 55014,
                "answer_text": "Vegeta",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 30004,
        "question_text": "Come si chiama il protagonista di Kaguya-sama?",
        "category": "Anime",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 55019,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 55017,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 55016,
                "answer_text": "Kaguya Shinomiya",
                "is_correct": 1
            },
            {
                "answer_id": 55018,
                "answer_text": "Vegeta",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 30005,
        "question_text": "Chi è il personaggio principale della serie Fringe?",
        "category": "Serie TV",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 55020,
                "answer_text": "Olivia Dunham",
                "is_correct": 1
            },
            {
                "answer_id": 55021,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 55023,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 55022,
                "answer_text": "Rick",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 30006,
        "question_text": "Chi è il personaggio principale della serie Better Things?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 55027,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 55025,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 55026,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 55024,
                "answer_text": "Sam Fox",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 30007,
        "question_text": "Chi è il personaggio principale della serie Stranger?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 55029,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 55028,
                "answer_text": "Hwang Si-mok",
                "is_correct": 1
            },
            {
                "answer_id": 55030,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 55031,
                "answer_text": "Joe",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 30008,
        "question_text": "Chi è il personaggio principale della serie This Is Us?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 55035,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 55033,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 55034,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 55032,
                "answer_text": "Jack Pearson",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 30009,
        "question_text": "Chi è il personaggio principale della serie The Haunting of Hill House?",
        "category": "Serie TV",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 55039,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 55038,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 55036,
                "answer_text": "Nell Crain",
                "is_correct": 1
            },
            {
                "answer_id": 55037,
                "answer_text": "Tyrion",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 30010,
        "question_text": "Cosa significa la parola 'fiore' in inglese?",
        "category": "Inglese",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 55040,
                "answer_text": "flower",
                "is_correct": 1
            },
            {
                "answer_id": 55041,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 55042,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 55043,
                "answer_text": "water",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 30011,
        "question_text": "Cosa significa la parola 'albero' in inglese?",
        "category": "Inglese",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 55044,
                "answer_text": "tree",
                "is_correct": 1
            },
            {
                "answer_id": 55047,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 55046,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 55045,
                "answer_text": "tree",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 30012,
        "question_text": "Cosa significa la parola 'tempo (cronologico)' in inglese?",
        "category": "Inglese",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 55048,
                "answer_text": "time",
                "is_correct": 1
            },
            {
                "answer_id": 55049,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 55051,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 55050,
                "answer_text": "cloud",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 30013,
        "question_text": "Cosa significa la parola 'giorno' in inglese?",
        "category": "Inglese",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 55053,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 55055,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 55052,
                "answer_text": "day",
                "is_correct": 1
            },
            {
                "answer_id": 55054,
                "answer_text": "cloud",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 30014,
        "question_text": "Cosa significa l'acronimo 'CMS'?",
        "category": "Informatica",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 55056,
                "answer_text": "Content Management System",
                "is_correct": 1
            },
            {
                "answer_id": 55059,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            },
            {
                "answer_id": 55057,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 55058,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 30015,
        "question_text": "Cosa significa l'acronimo 'OCR'?",
        "category": "Informatica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 55060,
                "answer_text": "Optical Character Recognition",
                "is_correct": 1
            },
            {
                "answer_id": 55063,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            },
            {
                "answer_id": 55061,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 55062,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 30016,
        "question_text": "Cosa rappresenta il concetto di debito pubblico?",
        "category": "Economia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 55064,
                "answer_text": "debito dello stato",
                "is_correct": 1
            },
            {
                "answer_id": 55065,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 55067,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 55066,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 30017,
        "question_text": "Cosa rappresenta il concetto di credito bancario?",
        "category": "Economia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 55069,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 55068,
                "answer_text": "prestito da banca",
                "is_correct": 1
            },
            {
                "answer_id": 55070,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 55071,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 30018,
        "question_text": "Cosa rappresenta il concetto di monopolio?",
        "category": "Economia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 55075,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 55074,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 55072,
                "answer_text": "unico venditore",
                "is_correct": 1
            },
            {
                "answer_id": 55073,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 30019,
        "question_text": "Cosa rappresenta il concetto di mercato libero?",
        "category": "Economia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 55077,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 55076,
                "answer_text": "assenza di interventi esterni",
                "is_correct": 1
            },
            {
                "answer_id": 55079,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 55078,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 30020,
        "question_text": "Cosa rappresenta il concetto di produttività?",
        "category": "Economia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 55080,
                "answer_text": "efficienza della produzione",
                "is_correct": 1
            },
            {
                "answer_id": 55083,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 55081,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 55082,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 30021,
        "question_text": "Chi ha scritto 'L'amore ai tempi del colera'?",
        "category": "Cultura Generale",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 55084,
                "answer_text": "Gabriel García Márquez",
                "is_correct": 1
            },
            {
                "answer_id": 55086,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 55087,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 55085,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 30022,
        "question_text": "Chi ha scritto 'Il nome del vento'?",
        "category": "Cultura Generale",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 55090,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 55091,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 55089,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 55088,
                "answer_text": "Patrick Rothfuss",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 30023,
        "question_text": "Chi ha scritto 'La strada'?",
        "category": "Cultura Generale",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 55095,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 55094,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 55093,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 55092,
                "answer_text": "Cormac McCarthy",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 30025,
        "question_text": "Chi ha scritto 'Notre-Dame de Paris'?",
        "category": "Cultura Generale",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 55102,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 55100,
                "answer_text": "Victor Hugo",
                "is_correct": 1
            },
            {
                "answer_id": 55103,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 55101,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 31000,
        "question_text": "Come si chiama il protagonista di Ergo Proxy?",
        "category": "Anime",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 57000,
                "answer_text": "Re-l Mayer",
                "is_correct": 1
            },
            {
                "answer_id": 57002,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 57001,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 57003,
                "answer_text": "Shinji",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 31001,
        "question_text": "Come si chiama il protagonista di Great Pretender?",
        "category": "Anime",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 57007,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 57005,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 57006,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 57004,
                "answer_text": "Makoto Edamura",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 31002,
        "question_text": "Come si chiama il protagonista di Beastars?",
        "category": "Anime",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 57010,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 57011,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 57009,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 57008,
                "answer_text": "Legoshi",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 31003,
        "question_text": "Come si chiama il protagonista di Barakamon?",
        "category": "Anime",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 57012,
                "answer_text": "Seishuu Handa",
                "is_correct": 1
            },
            {
                "answer_id": 57014,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 57013,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 57015,
                "answer_text": "Shinji",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 31004,
        "question_text": "Come si chiama il protagonista di Monster?",
        "category": "Anime",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 57016,
                "answer_text": "Kenzo Tenma",
                "is_correct": 1
            },
            {
                "answer_id": 57019,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 57018,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 57017,
                "answer_text": "Sasuke",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 31005,
        "question_text": "Chi è il personaggio principale della serie Ozark?",
        "category": "Serie TV",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 57023,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 57020,
                "answer_text": "Marty Byrde",
                "is_correct": 1
            },
            {
                "answer_id": 57021,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 57022,
                "answer_text": "Rick",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 31006,
        "question_text": "Chi è il personaggio principale della serie Shameless?",
        "category": "Serie TV",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 57025,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 57026,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 57024,
                "answer_text": "Frank Gallagher",
                "is_correct": 1
            },
            {
                "answer_id": 57027,
                "answer_text": "Joe",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 31007,
        "question_text": "Chi è il personaggio principale della serie The Expanse?",
        "category": "Serie TV",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 57028,
                "answer_text": "James Holden",
                "is_correct": 1
            },
            {
                "answer_id": 57030,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 57029,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 57031,
                "answer_text": "Joe",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 31008,
        "question_text": "Chi è il personaggio principale della serie The End of the F***ing World?",
        "category": "Serie TV",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 57034,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 57035,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 57032,
                "answer_text": "James",
                "is_correct": 1
            },
            {
                "answer_id": 57033,
                "answer_text": "Tyrion",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 31009,
        "question_text": "Chi è il personaggio principale della serie Dirk Gently?",
        "category": "Serie TV",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 57037,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 57039,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 57038,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 57036,
                "answer_text": "Dirk Gently",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 31010,
        "question_text": "Cosa significa la parola 'uomo' in inglese?",
        "category": "Inglese",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 57040,
                "answer_text": "man",
                "is_correct": 1
            },
            {
                "answer_id": 57041,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 57042,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 57043,
                "answer_text": "water",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 31011,
        "question_text": "Cosa significa la parola 'donna' in inglese?",
        "category": "Inglese",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 57046,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 57047,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 57045,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 57044,
                "answer_text": "woman",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 31012,
        "question_text": "Cosa significa la parola 'bambino' in inglese?",
        "category": "Inglese",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 57049,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 57050,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 57048,
                "answer_text": "child",
                "is_correct": 1
            },
            {
                "answer_id": 57051,
                "answer_text": "water",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 31013,
        "question_text": "Cosa significa la parola 'università' in inglese?",
        "category": "Inglese",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 57053,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 57052,
                "answer_text": "university",
                "is_correct": 1
            },
            {
                "answer_id": 57055,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 57054,
                "answer_text": "cloud",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 31014,
        "question_text": "Cosa significa l'acronimo 'GUI'?",
        "category": "Informatica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 57058,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 57057,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 57059,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            },
            {
                "answer_id": 57056,
                "answer_text": "Graphical User Interface",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 31015,
        "question_text": "Cosa significa l'acronimo 'QR'?",
        "category": "Informatica",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 57060,
                "answer_text": "Quick Response",
                "is_correct": 1
            },
            {
                "answer_id": 57062,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 57061,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 57063,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 31016,
        "question_text": "Cosa rappresenta il concetto di spesa pubblica?",
        "category": "Economia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 57066,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 57065,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 57067,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 57064,
                "answer_text": "uscite dello Stato",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 31017,
        "question_text": "Cosa rappresenta il concetto di deficit?",
        "category": "Economia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 57068,
                "answer_text": "mancanza di fondi",
                "is_correct": 1
            },
            {
                "answer_id": 57071,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 57069,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 57070,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 31018,
        "question_text": "Cosa rappresenta il concetto di avanzo primario?",
        "category": "Economia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 57074,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 57073,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 57072,
                "answer_text": "eccedenza entrate-spese",
                "is_correct": 1
            },
            {
                "answer_id": 57075,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 31019,
        "question_text": "Cosa rappresenta il concetto di consumo?",
        "category": "Economia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 57076,
                "answer_text": "utilizzo di beni",
                "is_correct": 1
            },
            {
                "answer_id": 57078,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 57079,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 57077,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 31020,
        "question_text": "Cosa rappresenta il concetto di importazione?",
        "category": "Economia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 57083,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 57080,
                "answer_text": "acquisto dall’estero",
                "is_correct": 1
            },
            {
                "answer_id": 57081,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 57082,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 31022,
        "question_text": "Chi ha scritto 'Il rosso e il nero'?",
        "category": "Cultura Generale",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 57090,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 57089,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 57091,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 57088,
                "answer_text": "Stendhal",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 31023,
        "question_text": "Chi ha scritto 'Il deserto dei Tartari'?",
        "category": "Cultura Generale",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 57092,
                "answer_text": "Dino Buzzati",
                "is_correct": 1
            },
            {
                "answer_id": 57095,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 57094,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 57093,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 31024,
        "question_text": "Chi ha scritto 'Il giardino segreto'?",
        "category": "Cultura Generale",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 57096,
                "answer_text": "Frances Hodgson Burnett",
                "is_correct": 1
            },
            {
                "answer_id": 57097,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 57098,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 57099,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 31025,
        "question_text": "Chi ha scritto 'Cuore'?",
        "category": "Cultura Generale",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 57102,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 57103,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 57100,
                "answer_text": "Edmondo De Amicis",
                "is_correct": 1
            },
            {
                "answer_id": 57101,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 32000,
        "question_text": "Come si chiama il protagonista di Yakusoku no Neverland?",
        "category": "Anime",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 59003,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 59002,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 59000,
                "answer_text": "Emma",
                "is_correct": 1
            },
            {
                "answer_id": 59001,
                "answer_text": "Sasuke",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 32001,
        "question_text": "Come si chiama il protagonista di Anohana?",
        "category": "Anime",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 59005,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 59006,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 59007,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 59004,
                "answer_text": "Jinta Yadomi",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 32002,
        "question_text": "Come si chiama il protagonista di Bungou Stray Dogs?",
        "category": "Anime",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 59009,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 59008,
                "answer_text": "Atsushi Nakajima",
                "is_correct": 1
            },
            {
                "answer_id": 59011,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 59010,
                "answer_text": "Vegeta",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 32003,
        "question_text": "Come si chiama il protagonista di Hellsing?",
        "category": "Anime",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 59015,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 59013,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 59014,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 59012,
                "answer_text": "Alucard",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 32004,
        "question_text": "Come si chiama il protagonista di Noragami?",
        "category": "Anime",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 59019,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 59018,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 59017,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 59016,
                "answer_text": "Yato",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 32005,
        "question_text": "Chi è il personaggio principale della serie Sense8?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 59020,
                "answer_text": "Will Gorski",
                "is_correct": 1
            },
            {
                "answer_id": 59022,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 59023,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 59021,
                "answer_text": "Tyrion",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 32006,
        "question_text": "Chi è il personaggio principale della serie The Umbrella Academy?",
        "category": "Serie TV",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 59027,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 59025,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 59024,
                "answer_text": "Vanya Hargreeves",
                "is_correct": 1
            },
            {
                "answer_id": 59026,
                "answer_text": "Rick",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 32007,
        "question_text": "Chi è il personaggio principale della serie Big Little Lies?",
        "category": "Serie TV",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 59028,
                "answer_text": "Celeste Wright",
                "is_correct": 1
            },
            {
                "answer_id": 59031,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 59029,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 59030,
                "answer_text": "Rick",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 32008,
        "question_text": "Chi è il personaggio principale della serie Penny Dreadful?",
        "category": "Serie TV",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 59035,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 59032,
                "answer_text": "Vanessa Ives",
                "is_correct": 1
            },
            {
                "answer_id": 59033,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 59034,
                "answer_text": "Rick",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 32009,
        "question_text": "Chi è il personaggio principale della serie House of the Dragon?",
        "category": "Serie TV",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 59039,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 59038,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 59037,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 59036,
                "answer_text": "Rhaenyra Targaryen",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 32010,
        "question_text": "Cosa significa la parola 'nuvola' in inglese?",
        "category": "Inglese",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 59041,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 59040,
                "answer_text": "cloud",
                "is_correct": 1
            },
            {
                "answer_id": 59043,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 59042,
                "answer_text": "cloud",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 32011,
        "question_text": "Cosa significa la parola 'pianta' in inglese?",
        "category": "Inglese",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 59046,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 59045,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 59044,
                "answer_text": "plant",
                "is_correct": 1
            },
            {
                "answer_id": 59047,
                "answer_text": "water",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 32012,
        "question_text": "Cosa significa la parola 'terra' in inglese?",
        "category": "Inglese",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 59050,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 59051,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 59048,
                "answer_text": "earth",
                "is_correct": 1
            },
            {
                "answer_id": 59049,
                "answer_text": "tree",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 32013,
        "question_text": "Cosa significa l'acronimo 'HTML5'?",
        "category": "Informatica",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 59054,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 59055,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            },
            {
                "answer_id": 59052,
                "answer_text": "nuova versione del linguaggio HTML",
                "is_correct": 1
            },
            {
                "answer_id": 59053,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 32014,
        "question_text": "Cosa significa l'acronimo 'BROWSER'?",
        "category": "Informatica",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 59059,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            },
            {
                "answer_id": 59058,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 59057,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 59056,
                "answer_text": "programma per navigare sul web",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 32015,
        "question_text": "Cosa significa l'acronimo 'FIREWALL'?",
        "category": "Informatica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 59060,
                "answer_text": "barriera di sicurezza digitale",
                "is_correct": 1
            },
            {
                "answer_id": 59063,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            },
            {
                "answer_id": 59062,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 59061,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 32016,
        "question_text": "Cosa significa l'acronimo 'BIT'?",
        "category": "Informatica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 59066,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 59064,
                "answer_text": "unità di informazione binaria",
                "is_correct": 1
            },
            {
                "answer_id": 59065,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 59067,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 32017,
        "question_text": "Cosa rappresenta il concetto di finanza?",
        "category": "Economia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 59071,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 59068,
                "answer_text": "gestione di risorse economiche",
                "is_correct": 1
            },
            {
                "answer_id": 59069,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 59070,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 32018,
        "question_text": "Cosa rappresenta il concetto di mercato azionario?",
        "category": "Economia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 59073,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 59075,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 59074,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 59072,
                "answer_text": "luogo di scambio di titoli",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 32019,
        "question_text": "Cosa rappresenta il concetto di crescita economica?",
        "category": "Economia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 59079,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 59078,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 59076,
                "answer_text": "incremento della produzione",
                "is_correct": 1
            },
            {
                "answer_id": 59077,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 32021,
        "question_text": "Chi ha scritto 'Moby Dick'?",
        "category": "Cultura Generale",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 59087,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 59085,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 59084,
                "answer_text": "Herman Melville",
                "is_correct": 1
            },
            {
                "answer_id": 59086,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 32022,
        "question_text": "Chi ha scritto 'La lettera scarlatta'?",
        "category": "Cultura Generale",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 59091,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 59089,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 59090,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 59088,
                "answer_text": "Nathaniel Hawthorne",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 33000,
        "question_text": "Come si chiama il protagonista di Serial Experiments Lain?",
        "category": "Anime",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 61002,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 61000,
                "answer_text": "Lain Iwakura",
                "is_correct": 1
            },
            {
                "answer_id": 61003,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 61001,
                "answer_text": "Sasuke",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 33001,
        "question_text": "Come si chiama il protagonista di Dororo?",
        "category": "Anime",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 61007,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 61006,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 61005,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 61004,
                "answer_text": "Hyakkimaru",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 33002,
        "question_text": "Come si chiama il protagonista di Kino's Journey?",
        "category": "Anime",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 61010,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 61009,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 61008,
                "answer_text": "Kino",
                "is_correct": 1
            },
            {
                "answer_id": 61011,
                "answer_text": "Shinji",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 33003,
        "question_text": "Come si chiama il protagonista di Nana?",
        "category": "Anime",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 61012,
                "answer_text": "Nana Osaki",
                "is_correct": 1
            },
            {
                "answer_id": 61013,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 61014,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 61015,
                "answer_text": "Shinji",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 33004,
        "question_text": "Chi è il personaggio principale della serie Bates Motel?",
        "category": "Serie TV",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 61017,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 61018,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 61016,
                "answer_text": "Norman Bates",
                "is_correct": 1
            },
            {
                "answer_id": 61019,
                "answer_text": "Joe",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 33005,
        "question_text": "Chi è il personaggio principale della serie The Morning Show?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 61023,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 61020,
                "answer_text": "Alex Levy",
                "is_correct": 1
            },
            {
                "answer_id": 61022,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 61021,
                "answer_text": "Tyrion",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 33006,
        "question_text": "Chi è il personaggio principale della serie Twin Peaks?",
        "category": "Serie TV",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 61025,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 61026,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 61027,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 61024,
                "answer_text": "Dale Cooper",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 33007,
        "question_text": "Chi è il personaggio principale della serie The Americans?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 61028,
                "answer_text": "Elizabeth Jennings",
                "is_correct": 1
            },
            {
                "answer_id": 61030,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 61029,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 61031,
                "answer_text": "Joe",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 33008,
        "question_text": "Chi è il personaggio principale della serie The Great?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 61033,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 61035,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 61032,
                "answer_text": "Catherine",
                "is_correct": 1
            },
            {
                "answer_id": 61034,
                "answer_text": "Rick",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 33009,
        "question_text": "Cosa significa la parola 'carta' in inglese?",
        "category": "Inglese",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 61037,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 61038,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 61039,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 61036,
                "answer_text": "paper",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 33010,
        "question_text": "Cosa significa la parola 'quaderno' in inglese?",
        "category": "Inglese",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 61043,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 61041,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 61040,
                "answer_text": "notebook",
                "is_correct": 1
            },
            {
                "answer_id": 61042,
                "answer_text": "cloud",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 33011,
        "question_text": "Cosa significa la parola 'lavagna' in inglese?",
        "category": "Inglese",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 61047,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 61044,
                "answer_text": "blackboard",
                "is_correct": 1
            },
            {
                "answer_id": 61046,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 61045,
                "answer_text": "tree",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 33012,
        "question_text": "Cosa significa la parola 'scaffale' in inglese?",
        "category": "Inglese",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 61049,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 61051,
                "answer_text": "water",
                "is_correct": 0
            },
            {
                "answer_id": 61050,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 61048,
                "answer_text": "shelf",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 33013,
        "question_text": "Cosa significa l'acronimo 'DOS'?",
        "category": "Informatica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 61054,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 61052,
                "answer_text": "Disk Operating System",
                "is_correct": 1
            },
            {
                "answer_id": 61055,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            },
            {
                "answer_id": 61053,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 33014,
        "question_text": "Cosa significa l'acronimo 'XML'?",
        "category": "Informatica",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 61059,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            },
            {
                "answer_id": 61056,
                "answer_text": "eXtensible Markup Language",
                "is_correct": 1
            },
            {
                "answer_id": 61057,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 61058,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 33015,
        "question_text": "Cosa rappresenta il concetto di mercato nero?",
        "category": "Economia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 61063,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 61061,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 61060,
                "answer_text": "scambi illegali",
                "is_correct": 1
            },
            {
                "answer_id": 61062,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 33016,
        "question_text": "Cosa rappresenta il concetto di imposta?",
        "category": "Economia",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 61065,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 61067,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 61064,
                "answer_text": "contributo obbligatorio",
                "is_correct": 1
            },
            {
                "answer_id": 61066,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 33017,
        "question_text": "Cosa rappresenta il concetto di IVA?",
        "category": "Economia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 61071,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 61069,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 61068,
                "answer_text": "Imposta sul Valore Aggiunto",
                "is_correct": 1
            },
            {
                "answer_id": 61070,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 33018,
        "question_text": "Cosa rappresenta il concetto di esportazione?",
        "category": "Economia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 61074,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 61073,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 61072,
                "answer_text": "vendita all’estero",
                "is_correct": 1
            },
            {
                "answer_id": 61075,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 33019,
        "question_text": "Chi ha scritto 'Il pendolo di Foucault'?",
        "category": "Cultura Generale",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 61079,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 61078,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 61076,
                "answer_text": "Umberto Eco",
                "is_correct": 1
            },
            {
                "answer_id": 61077,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 33020,
        "question_text": "Chi ha scritto 'La tregua'?",
        "category": "Cultura Generale",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 61082,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 61083,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 61080,
                "answer_text": "Primo Levi",
                "is_correct": 1
            },
            {
                "answer_id": 61081,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 33021,
        "question_text": "Chi ha scritto 'Cristo si è fermato a Eboli'?",
        "category": "Cultura Generale",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 61084,
                "answer_text": "Carlo Levi",
                "is_correct": 1
            },
            {
                "answer_id": 61086,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 61087,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 61085,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 33022,
        "question_text": "Chi ha scritto 'Il Visconte Dimezzato'?",
        "category": "Cultura Generale",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 61089,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 61090,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 61091,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 61088,
                "answer_text": "Italo Calvino",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 34000,
        "question_text": "Come si chiama il protagonista di Kill la Kill?",
        "category": "Anime",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 63002,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 63000,
                "answer_text": "Ryuko Matoi",
                "is_correct": 1
            },
            {
                "answer_id": 63003,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 63001,
                "answer_text": "Sasuke",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 34001,
        "question_text": "Come si chiama il protagonista di 91 Days?",
        "category": "Anime",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 63006,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 63004,
                "answer_text": "Angelo Lagusa",
                "is_correct": 1
            },
            {
                "answer_id": 63007,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 63005,
                "answer_text": "Sasuke",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 34002,
        "question_text": "Come si chiama il protagonista di Kaiji?",
        "category": "Anime",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 63010,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 63011,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 63009,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 63008,
                "answer_text": "Kaiji Itou",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 34003,
        "question_text": "Come si chiama il protagonista di Black Lagoon?",
        "category": "Anime",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 63014,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 63012,
                "answer_text": "Revy",
                "is_correct": 1
            },
            {
                "answer_id": 63015,
                "answer_text": "Shinji",
                "is_correct": 0
            },
            {
                "answer_id": 63013,
                "answer_text": "Sasuke",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 34004,
        "question_text": "Come si chiama il protagonista di Baccano!?",
        "category": "Anime",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 63018,
                "answer_text": "Vegeta",
                "is_correct": 0
            },
            {
                "answer_id": 63016,
                "answer_text": "Firo Prochainezo",
                "is_correct": 1
            },
            {
                "answer_id": 63017,
                "answer_text": "Sasuke",
                "is_correct": 0
            },
            {
                "answer_id": 63019,
                "answer_text": "Shinji",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 34005,
        "question_text": "Chi è il personaggio principale della serie Lupin?",
        "category": "Serie TV",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 63021,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 63023,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 63020,
                "answer_text": "Assane Diop",
                "is_correct": 1
            },
            {
                "answer_id": 63022,
                "answer_text": "Rick",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 34006,
        "question_text": "Chi è il personaggio principale della serie Chernobyl?",
        "category": "Serie TV",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 63026,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 63024,
                "answer_text": "Valery Legasov",
                "is_correct": 1
            },
            {
                "answer_id": 63027,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 63025,
                "answer_text": "Tyrion",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 34007,
        "question_text": "Chi è il personaggio principale della serie Bloodline?",
        "category": "Serie TV",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 63028,
                "answer_text": "John Rayburn",
                "is_correct": 1
            },
            {
                "answer_id": 63029,
                "answer_text": "Tyrion",
                "is_correct": 0
            },
            {
                "answer_id": 63031,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 63030,
                "answer_text": "Rick",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 34008,
        "question_text": "Chi è il personaggio principale della serie The Good Doctor?",
        "category": "Serie TV",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 63032,
                "answer_text": "Shaun Murphy",
                "is_correct": 1
            },
            {
                "answer_id": 63035,
                "answer_text": "Joe",
                "is_correct": 0
            },
            {
                "answer_id": 63034,
                "answer_text": "Rick",
                "is_correct": 0
            },
            {
                "answer_id": 63033,
                "answer_text": "Tyrion",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 34009,
        "question_text": "Cosa significa la parola 'pavimento' in inglese?",
        "category": "Inglese",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 63037,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 63036,
                "answer_text": "floor",
                "is_correct": 1
            },
            {
                "answer_id": 63038,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 63039,
                "answer_text": "water",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 34010,
        "question_text": "Cosa significa la parola 'tetto' in inglese?",
        "category": "Inglese",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 63040,
                "answer_text": "roof",
                "is_correct": 1
            },
            {
                "answer_id": 63041,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 63042,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 63043,
                "answer_text": "water",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 34011,
        "question_text": "Cosa significa la parola 'muro' in inglese?",
        "category": "Inglese",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 63045,
                "answer_text": "tree",
                "is_correct": 0
            },
            {
                "answer_id": 63044,
                "answer_text": "wall",
                "is_correct": 1
            },
            {
                "answer_id": 63046,
                "answer_text": "cloud",
                "is_correct": 0
            },
            {
                "answer_id": 63047,
                "answer_text": "water",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 34012,
        "question_text": "Cosa significa l'acronimo 'PHP'?",
        "category": "Informatica",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 63050,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            },
            {
                "answer_id": 63051,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            },
            {
                "answer_id": 63048,
                "answer_text": "Hypertext Preprocessor",
                "is_correct": 1
            },
            {
                "answer_id": 63049,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 34013,
        "question_text": "Cosa significa l'acronimo 'REST'?",
        "category": "Informatica",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 63052,
                "answer_text": "Representational State Transfer",
                "is_correct": 1
            },
            {
                "answer_id": 63055,
                "answer_text": "Digital Transfer System",
                "is_correct": 0
            },
            {
                "answer_id": 63053,
                "answer_text": "Advanced Protocol Interface",
                "is_correct": 0
            },
            {
                "answer_id": 63054,
                "answer_text": "Data Server Unit",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 34014,
        "question_text": "Cosa rappresenta il concetto di domanda aggregata?",
        "category": "Economia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 63059,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 63058,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 63057,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 63056,
                "answer_text": "richiesta totale di beni",
                "is_correct": 1
            }
        ]
    },
    {
        "id": 34015,
        "question_text": "Cosa rappresenta il concetto di mercato dei capitali?",
        "category": "Economia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 63063,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 63061,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 63060,
                "answer_text": "mercato per strumenti finanziari",
                "is_correct": 1
            },
            {
                "answer_id": 63062,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 34016,
        "question_text": "Cosa rappresenta il concetto di politica monetaria?",
        "category": "Economia",
        "difficulty": "facile",
        "answers": [
            {
                "answer_id": 63065,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            },
            {
                "answer_id": 63064,
                "answer_text": "gestione della moneta",
                "is_correct": 1
            },
            {
                "answer_id": 63067,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 63066,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 34017,
        "question_text": "Cosa rappresenta il concetto di disoccupazione?",
        "category": "Economia",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 63070,
                "answer_text": "prezzo minimo",
                "is_correct": 0
            },
            {
                "answer_id": 63068,
                "answer_text": "assenza di lavoro",
                "is_correct": 1
            },
            {
                "answer_id": 63071,
                "answer_text": "bilancio passivo",
                "is_correct": 0
            },
            {
                "answer_id": 63069,
                "answer_text": "spesa pubblica",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 34018,
        "question_text": "Chi ha scritto 'Il lupo della steppa'?",
        "category": "Cultura Generale",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 63072,
                "answer_text": "Hermann Hesse",
                "is_correct": 1
            },
            {
                "answer_id": 63075,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 63074,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 63073,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 34019,
        "question_text": "Chi ha scritto 'Dracula'?",
        "category": "Cultura Generale",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 63078,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 63076,
                "answer_text": "Bram Stoker",
                "is_correct": 1
            },
            {
                "answer_id": 63077,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 63079,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 34020,
        "question_text": "Chi ha scritto 'La banalità del male'?",
        "category": "Cultura Generale",
        "difficulty": "difficile",
        "answers": [
            {
                "answer_id": 63082,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 63083,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 63080,
                "answer_text": "Hannah Arendt",
                "is_correct": 1
            },
            {
                "answer_id": 63081,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            }
        ]
    },
    {
        "id": 34021,
        "question_text": "Chi ha scritto 'Il diario di Anna Frank'?",
        "category": "Cultura Generale",
        "difficulty": "media",
        "answers": [
            {
                "answer_id": 63087,
                "answer_text": "Giovanni Verga",
                "is_correct": 0
            },
            {
                "answer_id": 63086,
                "answer_text": "Giacomo Leopardi",
                "is_correct": 0
            },
            {
                "answer_id": 63085,
                "answer_text": "Gabriele D’Annunzio",
                "is_correct": 0
            },
            {
                "answer_id": 63084,
                "answer_text": "Anna Frank",
                "is_correct": 1
            }
        ]
    }
]