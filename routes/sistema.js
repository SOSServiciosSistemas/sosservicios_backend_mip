const express = require('express');
const router = express.Router();
const pool = require('../database');
const jwt = require('jsonwebtoken');
const { autenticarToken, JWT_SECRET } = require('../middleware/auth');

// Prueba de BD
router.get('/test-db', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW() AS hora_actual, current_database() AS nombre_bd');
        res.json({ mensaje: '¡Conexión exitosa a PostgreSQL!', datos: result.rows[0] });
    } catch (error) {
        res.status(500).json({ error: 'No se pudo conectar a la base de datos' });
    }
});

// Login con generación de JWT
router.post('/login', async (req, res) => {
    const { usuario, password } = req.body;
    try {
        const result = await pool.query(
            'SELECT id_usuario, nombre_completo, usuario, rol, firma_digital FROM usuarios WHERE LOWER(usuario) = LOWER($1) AND password_hash = $2 AND activo = true',
            [usuario, password]
        );
        if (result.rows.length > 0) {
            const user = result.rows[0];
            const token = jwt.sign(
                {
                    id_usuario: user.id_usuario,
                    usuario: user.usuario,
                    rol: user.rol,
                    nombre_completo: user.nombre_completo
                },
                JWT_SECRET,
                { expiresIn: '30d' }
            );

            res.json({ 
                exito: true, 
                mensaje: 'Bienvenido', 
                usuario: user,
                token: token
            });
        } else {
            res.status(401).json({ exito: false, error: 'Usuario o contraseña incorrectos' });
        }
    } catch (error) {
        res.status(500).json({ exito: false, error: 'Error interno del servidor' });
    }
});

// Endpoint para validar sesión y rol real de forma segura desde el backend
router.get('/verificar-sesion', autenticarToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id_usuario, nombre_completo, usuario, rol, activo, firma_digital FROM usuarios WHERE id_usuario = $1 AND activo = true',
            [req.usuario.id_usuario]
        );
        if (result.rows.length === 0) {
            return res.status(403).json({ exito: false, error: 'Usuario inactivo o dado de baja.' });
        }
        res.json({ exito: true, usuario: result.rows[0] });
    } catch (error) {
        res.status(500).json({ exito: false, error: 'Error al verificar sesión' });
    }
});

// Obtener firma digital de un usuario (para técnicos o mesa de control)
router.get('/usuarios/:id/firma', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id_usuario, nombre_completo, firma_digital FROM usuarios WHERE id_usuario = $1 AND activo = true',
            [req.params.id]
        );
        if (result.rows.length > 0) {
            res.json({ exito: true, usuario: result.rows[0] });
        } else {
            res.status(404).json({ exito: false, error: 'Usuario no encontrado' });
        }
    } catch (error) {
        res.status(500).json({ exito: false, error: 'Error al consultar firma' });
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

// Mesa de Control (para liquidación y firmas)
router.get('/mesa-control/usuarios', async (req, res) => {
    try {
        const query = `SELECT id_usuario, nombre_completo FROM usuarios WHERE rol = 'Mesa_Control' AND activo = true ORDER BY nombre_completo ASC;`;
        const result = await pool.query(query);
        res.json({ exito: true, usuarios: result.rows });
    } catch (error) {
        res.status(500).json({ exito: false, error: 'Error al obtener personal de mesa de control' });
    }
});

module.exports = router;