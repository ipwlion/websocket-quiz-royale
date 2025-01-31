const { pool } = require('./db'); // Assicurati che il percorso sia corretto

const initDb = async () => {
  try {
    await pool.query(`
     -- Elimina le tabelle se esistono
DROP TABLE IF EXISTS users, questions, answers, game_results CASCADE;

    `);

    await pool.query(`

-- Creazione tabella 'users' per gestire le credenziali
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    firstname VARCHAR(50) NOT NULL,
    lastname VARCHAR(50),
    email VARCHAR(100) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Creazione tabella 'questions' per memorizzare le domande
CREATE TABLE questions (
    id SERIAL PRIMARY KEY,
    question_text VARCHAR(255) NOT NULL,
    category VARCHAR(255),
    difficulty VARCHAR(25)
);

-- Creazione tabella 'answers' per memorizzare le risposte alle domande
CREATE TABLE answers (
    id SERIAL PRIMARY KEY,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    answer_text VARCHAR(255) NOT NULL,
    is_correct BOOLEAN DEFAULT FALSE
);

-- Creazione tabella 'game_results' per memorizzare lo storico delle partite
CREATE TABLE game_results (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    correct_answers_count INTEGER DEFAULT 0,
    total_time FLOAT DEFAULT 0
);

    `);

    console.log('Database initialized successfully!');
  } catch (err) {
    console.error('Error initializing database:', err.message);
  }
};

initDb();
