const { pool } = require('./db'); // Assicurati che il percorso sia corretto

const initDb = async () => {
  try {
    // Crea la tabella 'answers'
    await pool.query(`
      CREATE TABLE IF NOT EXISTS answers (
        id SERIAL PRIMARY KEY,
        question_id INTEGER NOT NULL,
        answer_text VARCHAR(255) NOT NULL,
        is_correct BOOLEAN DEFAULT FALSE
      );
    `);

    // Crea la tabella 'game_results'
    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_results (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        room_id INTEGER NOT NULL,
        correct_answers_count INTEGER DEFAULT 0,
        total_time FLOAT DEFAULT 0
      );
    `);

    // Crea la tabella 'game_status'
    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_status (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        room_id INTEGER NOT NULL,
        status VARCHAR(50) DEFAULT 'waiting'
      );
    `);

    // Crea la tabella 'questions'
    await pool.query(`
      CREATE TABLE IF NOT EXISTS questions (
        id SERIAL PRIMARY KEY,
        question_text VARCHAR(255) NOT NULL,
        category VARCHAR(255),
        difficulty VARCHAR(25)
      );
    `);

    // Crea la tabella 'rooms'
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id SERIAL PRIMARY KEY,
        player1_id INTEGER NOT NULL,
        player2_id INTEGER,
        status VARCHAR(50) DEFAULT 'waiting',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        question_quantity INTEGER DEFAULT 10,
        question_time INTEGER DEFAULT 10,
        question_category VARCHAR(255) DEFAULT 'Tutte le categorie'
      );
    `);

    // Crea la tabella 'room_questions'
    await pool.query(`
      CREATE TABLE IF NOT EXISTS room_questions (
        id SERIAL PRIMARY KEY,
        room_id INTEGER NOT NULL,
        question_id INTEGER NOT NULL
      );
    `);

    // Crea la tabella 'scores'
    await pool.query(`
      CREATE TABLE IF NOT EXISTS scores (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        score INTEGER DEFAULT 0
      );
    `);

    // Crea la tabella 'user'
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        firstname VARCHAR(50) NOT NULL,
        lastname VARCHAR(50),
        email VARCHAR(100) NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        password VARCHAR(255) NOT NULL
      );
    `);

    console.log('Database initialized successfully!');
  } catch (err) {
    console.error('Error initializing database:', err.message);
  }
};

initDb();
