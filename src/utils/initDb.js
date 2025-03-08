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


    `);

    console.log('Database initialized successfully!');
  } catch (err) {
    console.error('Error initializing database:', err.message);
  }
};

initDb();
