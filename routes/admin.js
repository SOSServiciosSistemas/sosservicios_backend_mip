const express = require('express');
const router = express.Router();
const pool = require('../database');

router.get('/admin/usuarios', async (req, res) => {
    try {
        // Solo lista usuarios operativos (Técnicos y Mesa de Control); Admin y Dirección se administran por terminal/servidor
        const result = await pool.query(`
            SELECT id_usuario, nombre_completo, usuario, rol, activo, firma_digital,
                   (firma_digital IS NOT NULL AND firma_digital != '') AS tiene_firma 
            FROM usuarios 
            WHERE rol NOT IN ('Admin', 'Direccion') 
            ORDER BY nombre_completo ASC;
        `);
        res.json({ exito: true, usuarios: result.rows });
    } catch (error) { 
        console.error("Error al obtener usuarios:", error);
        res.status(500).json({ exito: false, error: error.message || 'Error al obtener usuarios' }); 
    }
});

router.post('/admin/usuarios', async (req, res) => {
    const { nombre_completo, usuario, password, rol, firma_digital } = req.body;
    try {
        if (!nombre_completo || !usuario || !password || !rol) {
            return res.status(400).json({ exito: false, error: 'Todos los campos son obligatorios.' });
        }

        const nombreLimpio = nombre_completo.trim();
        const usuarioLimpio = usuario.trim();
        const passwordLimpio = password.trim();

        if (usuarioLimpio.length < 3) {
            return res.status(400).json({ exito: false, error: 'El nombre de usuario debe contener al menos 3 caracteres.' });
        }

        if (passwordLimpio.length < 4) {
            return res.status(400).json({ exito: false, error: 'La contraseña debe contener al menos 4 caracteres.' });
        }

        // Restricción de seguridad: Solo se permite crear Técnicos o Mesa de Control desde la vista web
        const rolesValidos = ['Tecnico', 'Mesa_Control'];
        if (!rolesValidos.includes(rol)) {
            return res.status(403).json({ 
                exito: false, 
                error: 'Permiso denegado: Desde el panel web únicamente se pueden crear usuarios con rol Técnico o Mesa de Control. Las cuentas de Administrador y Dirección solo pueden gestionarse directamente desde la consola del servidor.' 
            });
        }

        // Validar si el usuario ya existe (insensible a mayúsculas/minúsculas)
        const existe = await pool.query('SELECT id_usuario FROM usuarios WHERE LOWER(usuario) = LOWER($1);', [usuarioLimpio]);
        if (existe.rows.length > 0) {
            return res.status(400).json({ exito: false, error: 'El nombre de usuario "' + usuarioLimpio + '" ya está en uso. Por favor elija otro.' });
        }

        const resultado = await pool.query(`
            INSERT INTO usuarios (nombre_completo, usuario, password_hash, rol, activo, firma_digital)
            VALUES ($1, $2, $3, $4, true, $5)
            RETURNING id_usuario, nombre_completo, usuario, rol, activo, (firma_digital IS NOT NULL AND firma_digital != '') AS tiene_firma;
        `, [nombreLimpio, usuarioLimpio, passwordLimpio, rol, firma_digital || null]);

        const nuevoUsuario = resultado.rows[0];

        // Si el usuario es de tipo Técnico, registrar su almacén de camioneta si aún no existe
        if (rol === 'Tecnico') {
            try {
                const resAlm = await pool.query(`SELECT id_almacen FROM almacenes WHERE id_tecnico = $1 AND tipo_almacen = 'Camioneta'`, [nuevoUsuario.id_usuario]);
                if (resAlm.rows.length === 0) {
                    await pool.query(
                        `INSERT INTO almacenes (nombre, tipo_almacen, id_tecnico) VALUES ($1, 'Camioneta', $2);`,
                        [`Camioneta - ${nombreLimpio}`, nuevoUsuario.id_usuario]
                    );
                }
            } catch (errAlm) {
                console.warn('Aviso: El almacén de camioneta se generará automáticamente en el primer traspaso:', errAlm.message);
            }
        }

        res.json({ exito: true, mensaje: 'Usuario registrado exitosamente', usuario: nuevoUsuario });
    } catch (error) {
        console.error('Error al registrar usuario:', error);
        res.status(500).json({ exito: false, error: error.message || 'Error interno del servidor al crear usuario' });
    }
});

router.put('/admin/usuarios/:id/estatus', async (req, res) => {
    try {
        // Bloquear alteración de cuentas Admin y Dirección desde el panel
        const checkUser = await pool.query('SELECT rol FROM usuarios WHERE id_usuario = $1;', [req.params.id]);
        if (checkUser.rows.length === 0) {
            return res.status(404).json({ exito: false, error: 'Usuario no encontrado.' });
        }
        if (['Admin', 'Direccion'].includes(checkUser.rows[0].rol)) {
            return res.status(403).json({ 
                exito: false, 
                error: 'Protección de seguridad: No se puede modificar el estatus de cuentas con rol Administrador o Dirección desde el panel web.' 
            });
        }

        await pool.query(`UPDATE usuarios SET activo = $1 WHERE id_usuario = $2;`, [req.body.activo, req.params.id]);
        res.json({ exito: true });
    } catch (error) { 
        console.error("Error al actualizar estatus de usuario:", error);
        res.status(500).json({ exito: false, error: error.message }); 
    }
});

router.put('/admin/usuarios/:id/password', async (req, res) => {
    try {
        // Bloquear alteración de contraseñas de Admin y Dirección desde el panel
        const checkUser = await pool.query('SELECT rol FROM usuarios WHERE id_usuario = $1;', [req.params.id]);
        if (checkUser.rows.length === 0) {
            return res.status(404).json({ exito: false, error: 'Usuario no encontrado.' });
        }
        if (['Admin', 'Direccion'].includes(checkUser.rows[0].rol)) {
            return res.status(403).json({ 
                exito: false, 
                error: 'Protección de seguridad: No se pueden cambiar contraseñas de cuentas Administrador o Dirección desde el panel web.' 
            });
        }

        const { password } = req.body;
        if (!password || password.trim().length < 4) {
            return res.status(400).json({ exito: false, error: 'La nueva contraseña debe tener al menos 4 caracteres.' });
        }
        await pool.query(`UPDATE usuarios SET password_hash = $1 WHERE id_usuario = $2;`, [password.trim(), req.params.id]);
        res.json({ exito: true, mensaje: 'Contraseña actualizada exitosamente.' });
    } catch (error) {
        console.error("Error al actualizar contraseña:", error);
        res.status(500).json({ exito: false, error: error.message });
    }
});

router.put('/admin/usuarios/:id/firma', async (req, res) => {
    try {
        const checkUser = await pool.query('SELECT rol FROM usuarios WHERE id_usuario = $1;', [req.params.id]);
        if (checkUser.rows.length === 0) {
            return res.status(404).json({ exito: false, error: 'Usuario no encontrado.' });
        }
        if (['Admin', 'Direccion'].includes(checkUser.rows[0].rol)) {
            return res.status(403).json({ 
                exito: false, 
                error: 'Protección de seguridad: No se permite modificar firmas de Administrador o Dirección desde el panel.' 
            });
        }

        const { firma_digital } = req.body;
        if (!firma_digital) {
            return res.status(400).json({ exito: false, error: 'La firma es obligatoria.' });
        }

        await pool.query(`UPDATE usuarios SET firma_digital = $1 WHERE id_usuario = $2;`, [firma_digital, req.params.id]);
        res.json({ exito: true, mensaje: 'Firma digital registrada exitosamente.' });
    } catch (error) {
        console.error("Error al actualizar firma de usuario:", error);
        res.status(500).json({ exito: false, error: error.message });
    }
});

router.put('/admin/clientes/:id/estatus', async (req, res) => {
    try {
        await pool.query(`UPDATE clientes SET activo = $1 WHERE id_cliente = $2;`, [req.body.activo, req.params.id]);
        res.json({ exito: true });
    } catch (error) { res.status(500).json({ exito: false }); }
});

router.put('/admin/productos/:id/estatus', async (req, res) => {
    try {
        await pool.query(`UPDATE productos_insumos SET activo = $1 WHERE id_producto = $2;`, [req.body.activo, req.params.id]);
        res.json({ exito: true });
    } catch (error) { res.status(500).json({ exito: false }); }
});

router.get('/admin/productos', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM productos_insumos ORDER BY nombre_comercial ASC;`);
        res.json({ exito: true, productos: result.rows });
    } catch (error) { res.status(500).json({ exito: false }); }
});

router.post('/admin/productos', async (req, res) => {
    const { clave_producto, nombre_comercial, categoria, unidad_medida, capacidad_presentacion, stock_minimo, subcategoria, ingrediente_activo, registro_sanitario } = req.body;
    try {
        await pool.query(`
            INSERT INTO productos_insumos (clave_producto, nombre_comercial, categoria, unidad_medida, capacidad_presentacion, stock_minimo, subcategoria, ingrediente_activo, registro_sanitario) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);
        `, [clave_producto, nombre_comercial, categoria, unidad_medida, capacidad_presentacion, stock_minimo, subcategoria, ingrediente_activo, registro_sanitario]);
        res.json({ exito: true });
    } catch (error) { res.status(500).json({ exito: false }); }
});

module.exports = router;