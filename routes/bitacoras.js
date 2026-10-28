const express = require('express');
const router = express.Router();
const pool = require('../database');

router.get('/bitacoras/hoy/:id', async (req, res) => {
    try {
        // 1. Revisar si tiene alguna bitácora de un día anterior que haya quedado abierta ('En_Ruta')
        const resAnterior = await pool.query(`
            SELECT id_bitacora, fecha_jornada, estatus, km_inicial 
            FROM bitacoras_diarias 
            WHERE id_tecnico = $1 
              AND estatus = 'En_Ruta' 
              AND fecha_jornada::date < timezone('America/Mexico_City', now())::date 
            ORDER BY fecha_jornada ASC, id_bitacora ASC 
            LIMIT 1
        `, [req.params.id]);

        if (resAnterior.rows.length > 0) {
            return res.json({ 
                exito: true, 
                pendiente_cierre_anterior: true, 
                bitacora: resAnterior.rows[0] 
            });
        }

        // 2. Si no hay pendientes de días anteriores, buscar la bitácora del día actual
        const resHoy = await pool.query(`
            SELECT id_bitacora, fecha_jornada, estatus, km_inicial 
            FROM bitacoras_diarias 
            WHERE id_tecnico = $1 
              AND fecha_jornada::date = timezone('America/Mexico_City', now())::date 
            ORDER BY id_bitacora DESC 
            LIMIT 1
        `, [req.params.id]);

        res.json({ 
            exito: true, 
            pendiente_cierre_anterior: false, 
            bitacora: resHoy.rows.length > 0 ? resHoy.rows[0] : null 
        });
    } catch (error) { 
        console.error("Error al obtener bitácora actual/pendiente:", error);
        res.status(500).json({ exito: false, error: 'Error BD' }); 
    }
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
        // Candado: Verificar si tiene alguna bitácora de un día anterior aún sin cerrar
        const resPendiente = await pool.query(`
            SELECT id_bitacora, fecha_jornada 
            FROM bitacoras_diarias 
            WHERE id_tecnico = $1 
              AND estatus = 'En_Ruta' 
              AND fecha_jornada::date < timezone('America/Mexico_City', now())::date 
            LIMIT 1
        `, [id_tecnico]);

        if (resPendiente.rows.length > 0) {
            return res.status(400).json({ 
                exito: false, 
                error: 'Tienes una ruta anterior abierta sin cerrar. Debes firmar y cerrar el día anterior antes de iniciar una nueva jornada.' 
            });
        }

        const result = await pool.query(`
            INSERT INTO bitacoras_diarias (id_tecnico, km_inicial, revision_vehiculo, estatus, fecha_jornada) 
            VALUES ($1, $2, $3, 'En_Ruta', timezone('America/Mexico_City', now())::date) 
            RETURNING id_bitacora
        `, [id_tecnico, km_inicial, JSON.stringify(revision_vehiculo)]);
        res.json({ exito: true, id_bitacora: result.rows[0].id_bitacora });
    } catch (error) { 
        console.error("Error al abrir bitácora:", error);
        res.status(500).json({ exito: false, error: error.message }); 
    }
});

router.post('/bitacoras/actividad', async (req, res) => {
    const { id_bitacora, hora, descripcion, costo, ingreso, gasto } = req.body;
    try {
        await pool.query(`UPDATE bitacoras_diarias SET actividades_extra = actividades_extra || $1::jsonb WHERE id_bitacora = $2`, [JSON.stringify([{ hora, descripcion, costo, ingreso, gasto }]), id_bitacora]);
        res.json({ exito: true });
    } catch (error) { res.status(500).json({ exito: false }); }
});

router.post('/bitacoras/cerrar-ruta', async (req, res) => {
    const { id_bitacora, km_final, id_usuario, password, firma_tecnico } = req.body;
    try {
        const resCheck = await pool.query('SELECT id_tecnico, estatus FROM bitacoras_diarias WHERE id_bitacora = $1', [id_bitacora]);
        if (resCheck.rows.length === 0) return res.status(404).json({ exito: false, error: 'Bitácora no encontrada.' });
        if (resCheck.rows[0].estatus !== 'En_Ruta') return res.status(400).json({ exito: false, error: 'La ruta ya se encuentra cerrada.' });

        let firmaAEstampar = firma_tecnico;

        // Si se envió validación por contraseña (nuevo flujo oficial con firma electrónica)
        if (password) {
            const idTecnico = id_usuario || resCheck.rows[0].id_tecnico;
            const resUser = await pool.query('SELECT id_usuario, password_hash, firma_digital FROM usuarios WHERE id_usuario = $1 AND activo = true', [idTecnico]);
            if (resUser.rows.length === 0) {
                return res.status(404).json({ exito: false, error: 'Técnico no encontrado o inactivo.' });
            }
            if (resUser.rows[0].password_hash !== password) {
                return res.status(401).json({ exito: false, error: 'Contraseña incorrecta. No se pudo verificar la firma del técnico.' });
            }
            if (!resUser.rows[0].firma_digital) {
                return res.status(400).json({ exito: false, error: 'El técnico no tiene una firma oficial registrada. Solicite al administrador registrar su firma en el panel.' });
            }
            firmaAEstampar = resUser.rows[0].firma_digital;
        }

        if (!firmaAEstampar) {
            return res.status(400).json({ exito: false, error: 'Se requiere firma para cerrar la ruta.' });
        }

        await pool.query(
            `UPDATE bitacoras_diarias SET estatus = 'Cerrada_Ruta', km_final = $1, firmas_cierre = $2::jsonb WHERE id_bitacora = $3`,
            [km_final, JSON.stringify({ tecnico: firmaAEstampar }), id_bitacora]
        );
        res.json({ exito: true, mensaje: 'Ruta cerrada y firmada exitosamente.' });
    } catch (error) {
        console.error("Error al cerrar ruta:", error);
        res.status(500).json({ exito: false, error: error.message });
    }
});

router.post('/bitacoras/entregar', async (req, res) => {
    const { id_bitacora, id_usuario_responsable, password, total_entregado, firma_responsable } = req.body;
    try {
        const resBitacora = await pool.query('SELECT firmas_cierre FROM bitacoras_diarias WHERE id_bitacora = $1', [id_bitacora]);
        if (resBitacora.rows.length === 0) return res.status(404).json({ exito: false, error: 'Bitácora no encontrada.' });

        let firmas = resBitacora.rows[0].firmas_cierre || {};
        let firmaAEstampar = firma_responsable;

        // Si se envió validación por contraseña (nuevo flujo oficial)
        if (password) {
            if (!id_usuario_responsable) {
                return res.status(400).json({ exito: false, error: 'Debe seleccionar el usuario responsable de Mesa de Control.' });
            }
            const resUser = await pool.query(
                `SELECT id_usuario, nombre_completo, rol, password_hash, firma_digital FROM usuarios WHERE id_usuario = $1 AND activo = true`,
                [id_usuario_responsable]
            );
            if (resUser.rows.length === 0) {
                return res.status(404).json({ exito: false, error: 'Usuario responsable no encontrado o inactivo.' });
            }
            if (resUser.rows[0].rol !== 'Mesa_Control' && resUser.rows[0].rol !== 'Admin') {
                return res.status(403).json({ exito: false, error: 'El usuario seleccionado no pertenece a Mesa de Control.' });
            }
            if (resUser.rows[0].password_hash !== password) {
                return res.status(401).json({ exito: false, error: 'Contraseña de Mesa de Control incorrecta.' });
            }
            if (!resUser.rows[0].firma_digital) {
                return res.status(400).json({ exito: false, error: 'El usuario de Mesa de Control no tiene una firma oficial registrada.' });
            }
            firmaAEstampar = resUser.rows[0].firma_digital;
        }

        if (!firmaAEstampar) {
            return res.status(400).json({ exito: false, error: 'Se requiere firma de Mesa de Control para liquidar.' });
        }

        firmas.responsable = firmaAEstampar;
        await pool.query(
            `UPDATE bitacoras_diarias SET estatus = 'Entregada', firmas_cierre = $1::jsonb, total_efectivo_entregado = $2 WHERE id_bitacora = $3`,
            [JSON.stringify(firmas), total_entregado, id_bitacora]
        );
        res.json({ exito: true, mensaje: 'Liquidación completada y firmada exitosamente.' });
    } catch (error) {
        console.error("Error al entregar/liquidar bitácora:", error);
        res.status(500).json({ exito: false, error: error.message });
    }
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
        const result = await pool.query(`
            SELECT b.id_bitacora, b.fecha_jornada, u.nombre_completo AS tecnico, b.estatus, 
                   b.total_efectivo_entregado, b.km_inicial, b.km_final,
                   (b.fecha_jornada::date = timezone('America/Mexico_City', now())::date) AS es_hoy
            FROM bitacoras_diarias b 
            JOIN usuarios u ON b.id_tecnico = u.id_usuario 
            ORDER BY b.fecha_jornada DESC, b.id_bitacora DESC;
        `);
        res.json({ exito: true, bitacoras: result.rows });
    } catch (error) { res.status(500).json({ exito: false }); }
});

router.post('/bitacoras/:id/reabrir', async (req, res) => {
    const idBitacora = req.params.id;
    try {
        const resCheck = await pool.query(
            `SELECT id_bitacora, fecha_jornada, estatus, id_tecnico,
                    (fecha_jornada::date = timezone('America/Mexico_City', now())::date) AS es_hoy
             FROM bitacoras_diarias 
             WHERE id_bitacora = $1`,
            [idBitacora]
        );
        if (resCheck.rows.length === 0) {
            return res.status(404).json({ exito: false, error: 'Bitácora no encontrada.' });
        }

        const bitacora = resCheck.rows[0];

        // Condición 1: Solo se pueden reabrir rutas del día de hoy en curso
        if (!bitacora.es_hoy) {
            return res.status(400).json({ 
                exito: false, 
                error: 'No es posible reabrir rutas de días anteriores. Solo se pueden reabrir rutas del día de hoy.' 
            });
        }

        // Condición 2: Mesa de Control no debe haberla firmado/liquidado ya
        if (bitacora.estatus === 'Entregada') {
            return res.status(400).json({ 
                exito: false, 
                error: 'No se puede reabrir porque esta ruta ya fue recibida y firmada por Mesa de Control.' 
            });
        }

        if (bitacora.estatus === 'En_Ruta') {
            return res.status(400).json({ 
                exito: false, 
                error: 'La ruta ya se encuentra abierta y activa.' 
            });
        }

        // Si cumple las condiciones (estatus es 'Cerrada_Ruta'), reabrir restableciendo estatus y limpiando km_final y firmas:
        await pool.query(
            `UPDATE bitacoras_diarias 
             SET estatus = 'En_Ruta', km_final = NULL, firmas_cierre = '{}'::jsonb 
             WHERE id_bitacora = $1`,
            [idBitacora]
        );

        res.json({ 
            exito: true, 
            mensaje: 'Ruta reabierta con éxito. El técnico ya puede visualizar su agenda y registrar nuevos servicios.' 
        });
    } catch (error) {
        console.error("Error al reabrir ruta:", error);
        res.status(500).json({ exito: false, error: error.message });
    }
});

module.exports = router;