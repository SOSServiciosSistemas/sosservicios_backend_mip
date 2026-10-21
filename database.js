// database.js
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// Asegurar columna de firma digital en tabla usuarios
pool.query('ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS firma_digital TEXT;')
    .catch(err => console.warn('Aviso al verificar columna firma_digital:', err.message));

module.exports = pool;