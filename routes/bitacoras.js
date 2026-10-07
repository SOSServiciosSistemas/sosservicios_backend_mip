const express = require('express');
const router = express.Router();
const pool = require('../database');

router.get('/bitacoras/hoy/:id', async (req, res) => {
    try {
        const result = await pool.query(`SELECT id_bitacora, estatus, km_inicial FROM bitacoras_diarias WHERE id_tecnico = $1 AND (estatus = 'En_Ruta' OR fecha_jornada = CURRENT_DATE) ORDER BY fecha_jornada DESC, id_bitacora DESC LIMIT 1`, [req.params.id]);
        res.json({ exito: true, bitacora: result.rows.length > 0 ? result.rows[0] : null });
    } catch (error) { res.status(500).json({ exito: false, error: 'Error BD' }); }
});

router.get('/bitacoras/tecnico/:id_tecnico', async (req, res) => {
    try {
        const result = await pool.query(`SELECT id_bitacora, fecha_jornada, estatus FROM bitacoras_diarias WHERE id_tecnico = $1 ORDER BY fecha_jornada DESC, id_bitacora DESC;`, [req.params.id_tecnico]);
        res.json({ exito: true, bitacoras: result.rows });
    } catch (error) { res.status(500).json({ exito: false }); }
});

router.post('/bitacoras/abrir', async (req, res) => {
    const { id_tecnico, km_inicial, revision_vehiculo } = req.body;
    try {
        const result = await pool.query(`INSERT INTO bitacoras_diarias (id_tecnico, km_inicial, revision_vehiculo, estatus) VALUES ($1, $2, $3, 'En_Ruta') RETURNING id_bitacora`, [id_tecnico, km_inicial, JSON.stringify(revision_vehiculo)]);
        res.json({ exito: true, id_bitacora: result.rows[0].id_bitacora });
    } catch (error) { res.status(500).json({ exito: false }); }
});

router.post('/bitacoras/actividad', async (req, res) => {
    const { id_bitacora, hora, descripcion, costo, ingreso, gasto } = req.body;
    try {
        await pool.query(`UPDATE bitacoras_diarias SET actividades_extra = actividades_extra || $1::jsonb WHERE id_bitacora = $2`, [JSON.stringify([{ hora, descripcion, costo, ingreso, gasto }]), id_bitacora]);
        res.json({ exito: true });
    } catch (error) { res.status(500).json({ exito: false }); }
});

router.post('/bitacoras/cerrar-ruta', async (req, res) => {
    const { id_bitacora, km_final, firma_tecnico } = req.body;
    try {
        const resCheck = await pool.query('SELECT estatus FROM bitacoras_diarias WHERE id_bitacora = $1', [id_bitacora]);
        if (resCheck.rows.length === 0 || resCheck.rows[0].estatus !== 'En_Ruta') return res.status(400).json({ exito: false, error: 'Ruta ya cerrada.' });
        await pool.query(`UPDATE bitacoras_diarias SET estatus = 'Cerrada_Ruta', km_final = $1, firmas_cierre = $2 WHERE id_bitacora = $3`, [km_final, JSON.stringify({ tecnico: firma_tecnico }), id_bitacora]);
        res.json({ exito: true });
    } catch (error) { res.status(500).json({ exito: false }); }
});

router.post('/bitacoras/entregar', async (req, res) => {
    const { id_bitacora, firma_responsable, total_entregado } = req.body;
    try {
        const resBitacora = await pool.query('SELECT firmas_cierre FROM bitacoras_diarias WHERE id_bitacora = $1', [id_bitacora]);
        let firmas = resBitacora.rows[0].firmas_cierre || {};
        firmas.responsable = firma_responsable;
        await pool.query(`UPDATE bitacoras_diarias SET estatus = 'Entregada', firmas_cierre = $1::jsonb, total_efectivo_entregado = $2 WHERE id_bitacora = $3`, [JSON.stringify(firmas), total_entregado, id_bitacora]);
        res.json({ exito: true });
    } catch (error) { res.status(500).json({ exito: false }); }
});

router.get('/bitacoras/resumen/:id_bitacora', async (req, res) => {
    try {
        const resBitacora = await pool.query(`SELECT b.*, u.nombre_completo AS nombre_tecnico FROM bitacoras_diarias b JOIN usuarios u ON b.id_tecnico = u.id_usuario WHERE b.id_bitacora = $1`, [req.params.id_bitacora]);
        if (resBitacora.rows.length === 0) return res.status(404).json({ exito: false, error: 'No existe' });
        
        const bitacora = resBitacora.rows[0];
        const resOrdenes = await pool.query(`
            SELECT o.id_orden, o.fecha_programada, o.tipo_servicio, o.ingresos_cobrados, c.nombre AS nombre_cliente, r.detalles_ejecucion, cp.costo_con_iva AS costo
            FROM ordenes_trabajo o JOIN ubicaciones u ON o.id_ubicacion = u.id_ubicacion JOIN clientes c ON u.id_cliente = c.id_cliente LEFT JOIN reportes_mip r ON o.id_orden = r.id_orden LEFT JOIN control_pagos cp ON o.id_orden = cp.id_orden
            WHERE o.id_tecnico = $1 AND o.fecha_programada::date = $2 AND o.estatus = 'Completado' ORDER BY o.fecha_programada ASC;
        `, [bitacora.id_tecnico, bitacora.fecha_jornada]);
        res.json({ exito: true, bitacora: bitacora, servicios: resOrdenes.rows });
    } catch (error) { res.status(500).json({ exito: false }); }
});

router.get('/bitacoras/historial', async (req, res) => {
    try {
        const result = await pool.query(`SELECT b.id_bitacora, b.fecha_jornada, u.nombre_completo AS tecnico, b.estatus, b.total_efectivo_entregado, b.km_inicial, b.km_final FROM bitacoras_diarias b JOIN usuarios u ON b.id_tecnico = u.id_usuario ORDER BY b.fecha_jornada DESC, b.id_bitacora DESC;`);
        res.json({ exito: true, bitacoras: result.rows });
    } catch (error) { res.status(500).json({ exito: false }); }
});

module.exports = router;