const express = require('express');
const router = express.Router();
const pool = require('../database');

router.post('/inventario/entrada', async (req, res) => {
    const { id_producto, cantidad_comprada, proveedor, costo_unitario, fecha_caducidad, id_usuario_registra } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const resProd = await client.query(`SELECT capacidad_presentacion, costo_promedio FROM productos_insumos WHERE id_producto = $1`, [id_producto]);
        if (resProd.rows.length === 0) throw new Error('Producto no encontrado');
        
        const capacidad = parseFloat(resProd.rows[0].capacidad_presentacion) || 1;
        const costoPromedioAnterior = parseFloat(resProd.rows[0].costo_promedio) || 0;
        const cantidadReal = parseFloat(cantidad_comprada) * capacidad; 
        const costoTotal = parseFloat(cantidad_comprada) * parseFloat(costo_unitario);

        let resAlmacen = await client.query(`SELECT id_almacen FROM almacenes WHERE tipo_almacen = 'General' LIMIT 1`);
        let idAlmacenGen = resAlmacen.rows.length === 0 ? (await client.query(`INSERT INTO almacenes (nombre, tipo_almacen) VALUES ('Almacén Central', 'General') RETURNING id_almacen`)).rows[0].id_almacen : resAlmacen.rows[0].id_almacen;

        const resInv = await client.query(`SELECT cantidad_disponible FROM inventario_actual WHERE id_producto = $1 AND id_almacen = $2`, [id_producto, idAlmacenGen]);
        let nuevoCostoPromedio = parseFloat(costo_unitario);

        if (resInv.rows.length > 0) {
            const stockAntEnvases = parseFloat(resInv.rows[0].cantidad_disponible) / capacidad;
            nuevoCostoPromedio = ((stockAntEnvases * costoPromedioAnterior) + costoTotal) / (stockAntEnvases + parseFloat(cantidad_comprada));
            await client.query(`UPDATE inventario_actual SET cantidad_disponible = cantidad_disponible + $1, fecha_caducidad = COALESCE($2, fecha_caducidad), ultima_actualizacion = CURRENT_TIMESTAMP WHERE id_producto = $3 AND id_almacen = $4`, [cantidadReal, fecha_caducidad || null, id_producto, idAlmacenGen]);
        } else {
            await client.query(`INSERT INTO inventario_actual (id_producto, id_almacen, cantidad_disponible, fecha_caducidad) VALUES ($1, $2, $3, $4)`, [id_producto, idAlmacenGen, cantidadReal, fecha_caducidad || null]);
        }

        await client.query(`UPDATE productos_insumos SET costo_promedio = $1 WHERE id_producto = $2`, [nuevoCostoPromedio, id_producto]);
        await client.query(`INSERT INTO movimientos_inventario (id_producto, id_almacen_destino, id_usuario_registra, tipo_movimiento, cantidad, proveedor, costo_unitario, costo_total, caducidad_ingresada) VALUES ($1, $2, $3, 'Entrada por Compra', $4, $5, $6, $7, $8)`, [id_producto, idAlmacenGen, id_usuario_registra || null, cantidadReal, proveedor, costo_unitario, costoTotal, fecha_caducidad || null]);

        await client.query('COMMIT');
        res.json({ exito: true });
    } catch (error) { await client.query('ROLLBACK'); res.status(500).json({ exito: false }); } finally { client.release(); }
});

router.get('/inventario/general', async (req, res) => {
    try {
        const { rows } = await pool.query(`SELECT p.clave_producto, p.nombre_comercial, p.unidad_medida, p.capacidad_presentacion, i.cantidad_disponible, p.costo_promedio, i.fecha_caducidad FROM inventario_actual i JOIN productos_insumos p ON i.id_producto = p.id_producto JOIN almacenes a ON i.id_almacen = a.id_almacen WHERE a.tipo_almacen = 'General' ORDER BY p.nombre_comercial ASC;`);
        res.json({ exito: true, inventario: rows });
    } catch (error) { res.status(500).json({ exito: false }); }
});

router.get('/inventario/tecnicos', async (req, res) => {
    try {
        const { rows } = await pool.query(`SELECT a.id_tecnico, a.nombre AS nombre_almacen, p.clave_producto, p.nombre_comercial, p.unidad_medida, p.capacidad_presentacion, i.cantidad_disponible FROM inventario_actual i JOIN productos_insumos p ON i.id_producto = p.id_producto JOIN almacenes a ON i.id_almacen = a.id_almacen WHERE a.tipo_almacen != 'General' ORDER BY a.nombre ASC, p.nombre_comercial ASC;`);
        res.json({ exito: true, inventario: rows });
    } catch (error) { res.status(500).json({ exito: false }); }
});

router.post('/inventario/traspaso', async (req, res) => {
    const { clave_producto, id_tecnico, nombre_tecnico, cantidad_entregada_base, notas, id_usuario_registra } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const resProd = await client.query('SELECT id_producto FROM productos_insumos WHERE clave_producto = $1', [clave_producto]);
        if (resProd.rows.length === 0) throw new Error('Producto no encontrado');
        const id_producto = resProd.rows[0].id_producto;

        const resAlmacenGen = await client.query(`SELECT id_almacen FROM almacenes WHERE tipo_almacen = 'General' LIMIT 1`);
        const id_almacen_general = resAlmacenGen.rows[0].id_almacen;

        let resAlmacenTec = await client.query(`SELECT id_almacen FROM almacenes WHERE id_tecnico = $1 AND tipo_almacen = 'Camioneta'`, [id_tecnico]);
        let id_almacen_tecnico = resAlmacenTec.rows.length === 0 ? (await client.query(`INSERT INTO almacenes (nombre, tipo_almacen, id_tecnico) VALUES ($1, 'Camioneta', $2) RETURNING id_almacen`, [`Camioneta - ${nombre_tecnico}`, id_tecnico])).rows[0].id_almacen : resAlmacenTec.rows[0].id_almacen;

        const resStockOficina = await client.query(`SELECT cantidad_disponible, fecha_caducidad FROM inventario_actual WHERE id_producto = $1 AND id_almacen = $2`, [id_producto, id_almacen_general]);
        if (resStockOficina.rows.length === 0 || parseFloat(resStockOficina.rows[0].cantidad_disponible) < parseFloat(cantidad_entregada_base)) throw new Error('Stock insuficiente');
        
        await client.query(`UPDATE inventario_actual SET cantidad_disponible = cantidad_disponible - $1, ultima_actualizacion = CURRENT_TIMESTAMP WHERE id_producto = $2 AND id_almacen = $3`, [cantidad_entregada_base, id_producto, id_almacen_general]);

        const resStockTecnico = await client.query(`SELECT cantidad_disponible FROM inventario_actual WHERE id_producto = $1 AND id_almacen = $2`, [id_producto, id_almacen_tecnico]);
        if (resStockTecnico.rows.length > 0) await client.query(`UPDATE inventario_actual SET cantidad_disponible = cantidad_disponible + $1, fecha_caducidad = COALESCE($2, fecha_caducidad), ultima_actualizacion = CURRENT_TIMESTAMP WHERE id_producto = $3 AND id_almacen = $4`, [cantidad_entregada_base, resStockOficina.rows[0].fecha_caducidad, id_producto, id_almacen_tecnico]);
        else await client.query(`INSERT INTO inventario_actual (id_producto, id_almacen, cantidad_disponible, fecha_caducidad) VALUES ($1, $2, $3, $4)`, [id_producto, id_almacen_tecnico, cantidad_entregada_base, resStockOficina.rows[0].fecha_caducidad]);

        await client.query(`INSERT INTO movimientos_inventario (id_producto, id_almacen_origen, id_almacen_destino, id_usuario_registra, tipo_movimiento, cantidad, notas) VALUES ($1, $2, $3, $4, 'Traspaso a Técnico', $5, $6)`, [id_producto, id_almacen_general, id_almacen_tecnico, id_usuario_registra || null, cantidad_entregada_base, notas]);
        
        await client.query('COMMIT'); res.json({ exito: true });
    } catch (error) { await client.query('ROLLBACK'); res.status(500).json({ exito: false, error: error.message }); } finally { client.release(); }
});

router.get('/inventario/historial', async (req, res) => {
    try {
        const { fechaInicio, fechaFin } = req.query;
        let condicionFechas = "", parametros = [];
        if (fechaInicio && fechaFin) {
            condicionFechas = "WHERE m.fecha_movimiento >= $1 AND m.fecha_movimiento <= $2";
            parametros = [fechaInicio + " 00:00:00", fechaFin + " 23:59:59"];
        }
        const { rows } = await pool.query(`
            SELECT m.id_movimiento, m.fecha_movimiento, m.tipo_movimiento, m.cantidad, m.notas, p.nombre_comercial, p.unidad_medida, COALESCE(ao.nombre, 'Proveedor Externo') AS origen, COALESCE(ad.nombre, 'Baja / Consumo') AS destino, COALESCE(u.nombre_completo, 'Sistema') AS usuario_registra
            FROM movimientos_inventario m JOIN productos_insumos p ON m.id_producto = p.id_producto LEFT JOIN almacenes ao ON m.id_almacen_origen = ao.id_almacen LEFT JOIN almacenes ad ON m.id_almacen_destino = ad.id_almacen LEFT JOIN usuarios u ON m.id_usuario_registra = u.id_usuario
            ${condicionFechas} ORDER BY m.fecha_movimiento DESC ${parametros.length === 0 ? "LIMIT 200" : ""}
        `, parametros);
        res.json({ exito: true, historial: rows });
    } catch (error) { res.status(500).json({ exito: false }); }
});

module.exports = router;