const express = require('express');
const router = express.Router();
const pool = require('../database');

router.get('/agenda-general', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT o.id_orden, o.fecha_programada, o.estatus, c.nombre AS nombre_cliente
            FROM ordenes_trabajo o
            JOIN ubicaciones u ON o.id_ubicacion = u.id_ubicacion
            JOIN clientes c ON u.id_cliente = c.id_cliente
        `);
        const eventos = result.rows.map(orden => {
            let color = '#6c757d', icono = '🕒';
            if (orden.estatus === 'Confirmado' || orden.estatus === 'Completado') { color = '#198754'; icono = '✔'; }
            else if (orden.estatus === 'Cancelado') { color = '#dc3545'; icono = '✖'; }
            return { id: orden.id_orden, title: `${icono} ${orden.nombre_cliente}`, start: orden.fecha_programada, color: color, extendedProps: { estatus: orden.estatus } };
        });
        res.json(eventos);
    } catch (error) {
        res.status(500).json({ error: 'Error BD' });
    }
});

router.get('/agenda/:id', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT o.id_orden, o.fecha_programada, o.tipo_servicio, o.observaciones_mesa, o.estatus, c.nombre AS nombre_cliente, u.colonia, u.domicilio
            FROM ordenes_trabajo o JOIN ubicaciones u ON o.id_ubicacion = u.id_ubicacion JOIN clientes c ON u.id_cliente = c.id_cliente
            WHERE o.id_tecnico = $1 AND o.estatus IN ('Pendiente', 'Confirmado') AND o.fecha_programada::date = timezone('America/Mexico_City', now())::date
            ORDER BY o.fecha_programada ASC;
        `, [req.params.id]);
        res.json({ exito: true, agenda: result.rows });
    } catch (error) {
        res.status(500).json({ exito: false, error: 'Error BD' });
    }
});

router.get('/historial-ordenes', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT o.id_orden, o.fecha_programada, o.tipo_servicio, o.estatus, c.nombre AS nombre_cliente, u.nombre_completo AS nombre_tecnico, ub.domicilio, ub.colonia, ub.ciudad
            FROM ordenes_trabajo o JOIN ubicaciones ub ON o.id_ubicacion = ub.id_ubicacion JOIN clientes c ON ub.id_cliente = c.id_cliente LEFT JOIN usuarios u ON o.id_tecnico = u.id_usuario ORDER BY o.fecha_programada ASC;
        `);
        res.json({ exito: true, historial: result.rows });
    } catch (error) {
        res.status(500).json({ exito: false, error: 'Error BD' });
    }
});

router.get('/orden/:id', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT o.*, c.id_cliente, c.nombre AS nombre_cliente, c.telefono, u.nombre_ubicacion, u.domicilio, u.colonia, u.ciudad
            FROM ordenes_trabajo o 
            LEFT JOIN ubicaciones u ON o.id_ubicacion = u.id_ubicacion 
            LEFT JOIN clientes c ON u.id_cliente = c.id_cliente 
            WHERE o.id_orden = $1
        `, [req.params.id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ exito: false, error: 'Orden no encontrada' });
        }

        const orden = result.rows[0];
        const numTrat = parseInt(orden.num_tratamiento) || 1;
        const totalTrat = parseInt(orden.total_tratamientos) || 1;
        const esMultiTratamiento = Boolean(totalTrat > 1 && orden.id_grupo);

        let costoTotalTratamiento = parseFloat(orden.costo_total_tratamiento || orden.costo || orden.ingresos_cobrados || 0);
        let totalCobradoPrevio = 0;
        let saldoPendiente = costoTotalTratamiento;

        if (esMultiTratamiento) {
            // Consultar todas las órdenes del mismo grupo para calcular historial de cobro
            const resGrupo = await pool.query(`
                SELECT id_orden, num_tratamiento, total_tratamientos, estatus, ingresos_cobrados, costo, costo_total_tratamiento
                FROM ordenes_trabajo
                WHERE id_grupo = $1
                ORDER BY num_tratamiento ASC
            `, [orden.id_grupo]);

            const ordenesGrupo = resGrupo.rows;

            // Determinar el costo total pactado del tratamiento (preferir el de la visita 1)
            const orden1 = ordenesGrupo.find(o => parseInt(o.num_tratamiento) === 1);
            if (orden1 && parseFloat(orden1.costo_total_tratamiento || orden1.costo || orden1.ingresos_cobrados) > 0) {
                costoTotalTratamiento = parseFloat(orden1.costo_total_tratamiento || orden1.costo || orden1.ingresos_cobrados);
            } else {
                const maxCosto = Math.max(...ordenesGrupo.map(o => parseFloat(o.costo_total_tratamiento || o.costo || o.ingresos_cobrados || 0)));
                if (maxCosto > 0) costoTotalTratamiento = maxCosto;
            }

            // Sumar lo efectivamente cobrado en visitas anteriores completadas
            const previasCompletadas = ordenesGrupo.filter(o => 
                o.estatus === 'Completado' && parseInt(o.num_tratamiento) < numTrat
            );
            totalCobradoPrevio = previasCompletadas.reduce((sum, o) => sum + (parseFloat(o.ingresos_cobrados) || 0), 0);

            // Saldo pendiente para esta visita
            saldoPendiente = Math.max(0, costoTotalTratamiento - totalCobradoPrevio);
        }

        orden.es_multitratamiento = esMultiTratamiento;
        orden.costo_total_tratamiento = costoTotalTratamiento;
        orden.total_cobrado_previo = totalCobradoPrevio;
        orden.saldo_pendiente = saldoPendiente;

        // Sugerir monto a cobrar: Si no está completado y es multi-tratamiento, el saldo pendiente; de lo contrario el registrado
        if (esMultiTratamiento && orden.estatus !== 'Completado') {
            orden.monto_sugerido_cobro = saldoPendiente;
        } else {
            orden.monto_sugerido_cobro = parseFloat(orden.ingresos_cobrados) || saldoPendiente;
        }

        res.json({ exito: true, orden });
    } catch (error) {
        console.error('Error al consultar orden:', error);
        res.status(500).json({ exito: false, error: 'Error BD' });
    }
});

router.post('/ordenes', async (req, res) => {
    const { id_ubicacion, id_tecnico, fecha_programada, tipo_servicio, observaciones_mesa, costo, num_tratamiento, total_tratamientos, frecuencia, plagas_a_tratar } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const total = parseInt(total_tratamientos) || 0;
        const inicioTratamiento = parseInt(num_tratamiento) || 0;
        const idGrupo = (total > 1) ? Date.now().toString() : null; 
        let fechaActual = new Date(fecha_programada), primerId = null;
        const iteraciones = (total > 1 && tipo_servicio === 'Aplicación') ? (total - inicioTratamiento + 1) : 1;
        const costoTotalTratamiento = parseFloat(costo) || 0;

        for (let i = 0; i < iteraciones; i++) {
            const tr = inicioTratamiento + i;
            const plagas = (tr === 1) ? plagas_a_tratar : '[]';
            // Solo el primer servicio lleva el costo total inicialmente; los siguientes inician en 0
            const costoVisita = (total > 1) ? ((tr === 1) ? costoTotalTratamiento : 0) : costoTotalTratamiento;

            const result = await client.query(`
                INSERT INTO ordenes_trabajo (id_ubicacion, id_tecnico, fecha_programada, tipo_servicio, observaciones_mesa, estatus, ingresos_cobrados, costo, costo_total_tratamiento, num_tratamiento, total_tratamientos, plagas_a_tratar, id_grupo)
                VALUES ($1, $2, $3, $4, $5, 'Pendiente', $6, $7, $8, $9, $10, $11, $12) RETURNING id_orden;
            `, [id_ubicacion, id_tecnico, fechaActual, tipo_servicio, observaciones_mesa, costoVisita, costoVisita, costoTotalTratamiento, tr, total, plagas, idGrupo]);
            
            if (i === 0) primerId = result.rows[0].id_orden;
            if (frecuencia === 'Semanal') fechaActual.setDate(fechaActual.getDate() + 7);
            else if (frecuencia === 'Quincenal') fechaActual.setDate(fechaActual.getDate() + 15);
            else if (frecuencia === 'Mensual') fechaActual.setMonth(fechaActual.getMonth() + 1);
            else if (frecuencia === 'Bimestral') fechaActual.setMonth(fechaActual.getMonth() + 2);
        }
        await client.query('COMMIT');
        res.json({ exito: true, id_orden: primerId });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al crear ordenes:', error);
        res.status(500).json({ exito: false, error: 'Error BD' });
    } finally { client.release(); }
});

router.put('/ordenes/:id', async (req, res) => {
    const { id_ubicacion, fecha_programada, id_tecnico, tipo_servicio, costo, observaciones_mesa } = req.body;
    try {
        const resOrden = await pool.query('SELECT id_grupo, num_tratamiento, total_tratamientos FROM ordenes_trabajo WHERE id_orden = $1', [req.params.id]);
        const ordenActual = resOrden.rows[0];

        await pool.query(`UPDATE ordenes_trabajo SET id_ubicacion=$1, fecha_programada=$2, id_tecnico=$3, tipo_servicio=$4, costo=$5, observaciones_mesa=$6 WHERE id_orden=$7`, [id_ubicacion, fecha_programada, id_tecnico, tipo_servicio, costo, observaciones_mesa, req.params.id]);

        if (ordenActual && ordenActual.id_grupo) {
            // Si se edita la visita 1 de un grupo, actualizar costo_total_tratamiento en todo el grupo
            if (parseInt(ordenActual.num_tratamiento) === 1 && costo !== undefined) {
                await pool.query(`UPDATE ordenes_trabajo SET costo_total_tratamiento=$1 WHERE id_grupo=$2`, [costo, ordenActual.id_grupo]);
            }
            // Actualizar ubicación y tipo_servicio en visitas pendientes consecutivas sin sobreescribir sus costos de visita a 0
            await pool.query(`UPDATE ordenes_trabajo SET id_ubicacion=$1, tipo_servicio=$2 WHERE id_grupo=$3 AND num_tratamiento>$4 AND estatus='Pendiente'`, [id_ubicacion, tipo_servicio, ordenActual.id_grupo, ordenActual.num_tratamiento]);
        }
        res.json({ exito: true });
    } catch (error) { res.status(500).json({ exito: false }); }
});

router.put('/ordenes/:id/estatus', async (req, res) => {
    const { estatus } = req.body;
    try {
        const resOrden = await pool.query('SELECT id_grupo, num_tratamiento FROM ordenes_trabajo WHERE id_orden = $1', [req.params.id]);
        await pool.query('UPDATE ordenes_trabajo SET estatus=$1 WHERE id_orden=$2', [estatus, req.params.id]);
        if (resOrden.rows[0] && resOrden.rows[0].id_grupo) {
            if (estatus === 'Cancelado') await pool.query(`UPDATE ordenes_trabajo SET estatus='Cancelado' WHERE id_grupo=$1 AND num_tratamiento>$2 AND estatus='Pendiente'`, [resOrden.rows[0].id_grupo, resOrden.rows[0].num_tratamiento]);
            else if (estatus === 'Pendiente' || estatus === 'Confirmado') await pool.query(`UPDATE ordenes_trabajo SET estatus='Pendiente' WHERE id_grupo=$1 AND num_tratamiento>$2 AND estatus='Cancelado'`, [resOrden.rows[0].id_grupo, resOrden.rows[0].num_tratamiento]);
        }
        res.json({ exito: true });
    } catch (error) { res.status(500).json({ exito: false }); }
});

router.put('/ordenes/:id/reagendar', async (req, res) => {
    const { fecha_programada } = req.body;
    try {
        const resOrden = await pool.query('SELECT id_grupo, num_tratamiento FROM ordenes_trabajo WHERE id_orden = $1', [req.params.id]);
        await pool.query(`UPDATE ordenes_trabajo SET fecha_programada=$1, estatus='Pendiente' WHERE id_orden=$2`, [fecha_programada, req.params.id]);
        if (resOrden.rows[0] && resOrden.rows[0].id_grupo) await pool.query(`UPDATE ordenes_trabajo SET estatus='Pendiente' WHERE id_grupo=$1 AND num_tratamiento>$2 AND estatus='Cancelado'`, [resOrden.rows[0].id_grupo, resOrden.rows[0].num_tratamiento]);
        res.json({ exito: true });
    } catch (error) { res.status(500).json({ exito: false }); }
});

module.exports = router;