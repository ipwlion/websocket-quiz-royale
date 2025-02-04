const { pool } = require('./db'); // Assicurati che il percorso sia corretto

const initDb = async () => {
  try {

    await pool.query(`


    `);

    console.log('Database initialized successfully!');
  } catch (err) {
    console.error('Error initializing database:', err.message);
  }
};

initDb();
