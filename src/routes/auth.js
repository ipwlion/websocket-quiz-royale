const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../utils/db');
const { registerSchema, loginSchema } = require('../utils/validationSchemas');
const router = express.Router();
const cors = require('cors');

// Middleware per CORS (può essere globale nel livello superiore dell'app)
const corsOptions = {
  origin: '*', // Sostituisci con il tuo dominio frontend
  methods: ['POST', 'GET'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};
router.use(cors(corsOptions)); // Configura CORS solo per queste rotte

// Registrazione
router.post('/register', async (req, res, next) => {
  try {
    const { error } = registerSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const { username, password } = req.body;

    // Hash della password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Inserimento nel database
    await pool.query(
      'INSERT INTO users (username, password, status) VALUES ($1, $2, $3)',
      [username, hashedPassword, 'offline']
    );

    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];
    res.status(201).json({ message: 'User registered successfully!', user });
  } catch (err) {
    // Gestione errore username duplicato
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username already exists' });
    }
    next(err);
  }
});

// Login
router.post('/login', async (req, res, next) => {
  try {
    const { error } = loginSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const { username, password } = req.body;

    // Recupero utente dal database
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);

    if (result.rowCount === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Verifica password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generazione del token JWT
    // const token = jwt.sign(
    //   { id: user.id, username: user.username },
    //   process.env.JWT_SECRET,
    //   { expiresIn: '1h' }
    // );

    res.status(200).json({
      message: 'Login successful!',
      user,
    });
  } catch (err) {
    next(err);
  }
});

// Esporta il router
module.exports = router;
