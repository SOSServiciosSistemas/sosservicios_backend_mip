const express = require('express');
const router = express.Router();
const pool = require('../database');

router.get('/admin/usuarios', async (req, res) => {
    try {
        const result = await pool.query(`SELECT id_usuario, nombre_completo, usuario, rol, activo FROM usuarios WHERE rol != 'Admin' ORDER BY nombre_completo ASC;`);
        res.json({ exito: true, usuarios: result.rows });
    } catch (error) { res.status(500).json({ exito: false }); }
});

router.get('/admin/clientes', async (req, res) => {
    try {
        const result = await pool.query(`SELECT id_cliente, nombre, clase, activo FROM clientes ORDER BY nombre ASC;`);
        res.json({ exito: true, clientes: result.rows });
    } catch (error) { res.status(500).json({ exito: false }); }
});

router.put('/admin/usuarios/:id/estatus', async (req, res) => {
    try {
        await pool.query(`UPDATE usuarios SET activo = $1 WHERE id_usuario = $2;`, [req.body.activo, req.params.id]);
        res.json({ exito: true });
    } catch (error) { res.status(500).json({ exito: false }); }
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