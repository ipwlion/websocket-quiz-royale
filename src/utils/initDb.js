const { pool } = require('./db'); // Assicurati che il percorso sia corretto

const initDb = async () => {
  try {

    await pool.query(`
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  subscription JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS game_results (
    id SERIAL PRIMARY KEY,
    room_id VARCHAR(255),
    user_id VARCHAR(255),
    correct_answers INT,
    total_time INT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS friend_requests (
  id SERIAL PRIMARY KEY,
  sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  receiver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
status VARCHAR(20) DEFAULT 'offline',
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (sender_id, receiver_id)
);

CREATE TABLE IF NOT EXISTS friends (
  id SERIAL PRIMARY KEY,
  user_id1 INTEGER REFERENCES users(id) ON DELETE CASCADE,
  user_id2 INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id1, user_id2)
);

CREATE TABLE ranked_results (
  id SERIAL PRIMARY KEY,         -- ID univoco del risultato
  room_id VARCHAR(255) NOT NULL, -- ID della stanza
  user_id INTEGER NOT NULL,      -- ID dell'utente
  correct_answers INTEGER NOT NULL, -- Numero di risposte corrette
  total_time INTEGER NOT NULL,   -- Tempo totale in secondi
  created_at TIMESTAMP DEFAULT NOW(), -- Data della partita
  CONSTRAINT unique_room_user UNIQUE (room_id, user_id) -- Impedisce duplicati per stesso match
);


    `);

    console.log('Database initialized successfully!');
  } catch (err) {
    console.error('Error initializing database:', err.message);
  }
};

initDb();
