const express = require('express');
const router = express.Router();
const pool = require('../database');

// Prueba de BD
router.get('/test-db', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW() AS hora_actual, current_database() AS nombre_bd');
        res.json({ mensaje: '¡Conexión exitosa a PostgreSQL!', datos: result.rows[0] });
    } catch (error) {
        res.status(500).json({ error: 'No se pudo conectar a la base de datos' });
    }
});

// Login
router.post('/login', async (req, res) => {
    const { usuario, password } = req.body;
    try {
        const result = await pool.query(
            'SELECT id_usuario, nombre_completo, rol FROM usuarios WHERE usuario = $1 AND password_hash = $2 AND activo = true',
            [usuario, password]
        );
        if (result.rows.length > 0) {
            res.json({ exito: true, mensaje: 'Bienvenido', usuario: result.rows[0] });
        } else {
            res.status(401).json({ exito: false, error: 'Usuario o contraseña incorrectos' });
        }
    } catch (error) {
        res.status(500).json({ exito: false, error: 'Error interno del servidor' });
    }
});

// Técnicos
router.get('/tecnicos', async (req, res) => {
    try {
        const query = `SELECT id_usuario, nombre_completo FROM usuarios WHERE rol = 'Tecnico' AND activo = true ORDER BY nombre_completo ASC;`;
        const result = await pool.query(query);
        res.json({ exito: true, tecnicos: result.rows });
    } catch (error) {
        res.status(500).json({ exito: false, error: 'Error en la base de datos' });
    }
});

module.exports = router;