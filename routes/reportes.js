const express = require('express');
const router = express.Router();
const pool = require('../database');

// 1. Obtiene el Reporte MIP vinculado a una orden específica
router.get('/reportes-mip/:id_orden', async (req, res) => {
    try {
        const result = await pool.query('SELECT id_reporte, letra_formato, hora_inicio, hora_fin, detalles_ejecucion, fecha_reporte FROM reportes_mip WHERE id_orden = $1;', [req.params.id_orden]);
        if (result.rows.length > 0) res.json({ exito: true, reporte: result.rows[0] });
        else res.json({ exito: false, mensaje: 'Reporte no encontrado' });
    } catch (error) { res.status(500).json({ exito: false, error: 'Error BD' }); }
});

// 2. RUTA PARA CARGAR EL REPORTE FINAL (Une Orden, Cliente y Químicos)
router.get('/ordenes/:id/reporte-final', async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT o.id_orden, o.fecha_programada AS fecha_servicio, o.num_tratamiento, o.total_tratamientos, o.ingresos_cobrados, r.hora_inicio AS hora_llegada, r.hora_fin AS hora_salida, u.nombre_completo AS nombre_tecnico, r.detalles_ejecucion, c.nombre AS nombre_cliente, c.contacto AS persona_contacto, c.telefono, c.giro AS giro_comercial, ub.domicilio AS direccion_completa, ub.ciudad, cp.costo_con_iva, cp.costo_sin_iva, cp.requiere_factura
            FROM ordenes_trabajo o JOIN ubicaciones ub ON o.id_ubicacion = ub.id_ubicacion JOIN clientes c ON ub.id_cliente = c.id_cliente LEFT JOIN usuarios u ON o.id_tecnico = u.id_usuario LEFT JOIN reportes_mip r ON o.id_orden = r.id_orden LEFT JOIN control_pagos cp ON o.id_orden = cp.id_orden WHERE o.id_orden = $1
        `, [req.params.id]);
        
        if (rows.length === 0) return res.status(404).json({ exito: false, error: 'Orden no encontrada' });

        const ordenData = rows[0];
        let productosJSON = [];
        
        if (ordenData.detalles_ejecucion) {
            const detalles = typeof ordenData.detalles_ejecucion === 'string' ? JSON.parse(ordenData.detalles_ejecucion) : ordenData.detalles_ejecucion;
            ordenData.acciones_realizadas = detalles.acciones_correctivas || '';
            ordenData.recomendaciones_seguimiento = detalles.indicaciones_proximas || '';
            productosJSON = detalles.tabla_productos || [];
            ordenData.detalles_completos = detalles; 
        }

        let productosEnriquecidos = [];
        for (const prod of productosJSON) {
            if (prod.clave_producto) {
                const resProd = await pool.query('SELECT nombre_comercial, ingrediente_activo, registro_sanitario, unidad_medida FROM productos_insumos WHERE clave_producto = $1', [prod.clave_producto]);
                if (resProd.rows.length > 0) {
                    const dbProd = resProd.rows[0];
                    productosEnriquecidos.push({
                        nombre_comercial: dbProd.nombre_comercial,
                        ingrediente_activo: dbProd.ingrediente_activo || dbProd.nombre_comercial,
                        registro_sanitario: dbProd.registro_sanitario || 'N/A',
                        cantidad_usada: prod.dosis || prod.gasto_real,
                        unidad_medida: dbProd.unidad_medida
                    });
                }
            } else {
                productosEnriquecidos.push({
                    nombre_comercial: prod.nombre_comercial || '',
                    ingrediente_activo: prod.ingrediente_activo || prod.nombre_comercial || '',
                    registro_sanitario: prod.registro_sanitario || 'N/A',
                    cantidad_usada: prod.dosis || prod.gasto_real || '',
                    unidad_medida: prod.unidad_medida || ''
                });
            }
        }
        res.json({ exito: true, orden: ordenData, productos_utilizados: productosEnriquecidos });
    } catch (error) { res.status(500).json({ exito: false, error: 'Error del servidor' }); }
});

// 3. Registra el Reporte MIP, marca completada y descuenta inventario
router.post('/reportes', async (req, res) => {
    const { id_orden, letra, hora_inicio, hora_fin, detalles, id_tecnico } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const horaInicioSegura = hora_inicio ? hora_inicio : new Date().toISOString();
        const horaFinSegura = hora_fin ? hora_fin : new Date().toISOString();

        await client.query(`INSERT INTO reportes_mip (id_orden, letra_formato, hora_inicio, hora_fin, detalles_ejecucion, fecha_reporte) VALUES ($1, $2, $3, $4, $5, timezone('America/Mexico_City', now()))`, [id_orden, letra, horaInicioSegura, horaFinSegura, JSON.stringify(detalles)]);
        await client.query(`UPDATE ordenes_trabajo SET estatus = 'Completado' WHERE id_orden = $1`, [id_orden]);

        if (id_tecnico && detalles.tabla_productos && detalles.tabla_productos.length > 0) {
            const resAlmacen = await client.query(`SELECT id_almacen FROM almacenes WHERE id_tecnico = $1 AND tipo_almacen != 'General' LIMIT 1`, [id_tecnico]);
            if (resAlmacen.rows.length > 0) {
                const id_almacen_tecnico = resAlmacen.rows[0].id_almacen;
                for (const prod of detalles.tabla_productos) {
                    const gastoReal = parseFloat(prod.gasto_real) || 0;
                    if (gastoReal > 0) {
                        const resProducto = await client.query(`SELECT id_producto FROM productos_insumos WHERE clave_producto = $1`, [prod.clave_producto]);
                        if (resProducto.rows.length > 0) {
                            const id_producto = resProducto.rows[0].id_producto;
                            await client.query(`UPDATE inventario_actual SET cantidad_disponible = cantidad_disponible - $1 WHERE id_almacen = $2 AND id_producto = $3`, [gastoReal, id_almacen_tecnico, id_producto]);
                            await client.query(`INSERT INTO movimientos_inventario (id_producto, id_almacen_origen, tipo_movimiento, cantidad, id_usuario_registra, notas) VALUES ($1, $2, 'Consumo', $3, $4, $5)`, [id_producto, id_almacen_tecnico, gastoReal, id_tecnico, `Consumo en Reporte MIP - Orden #${id_orden}`]);
                        }
                    }
                }
            }
        }
        await client.query('COMMIT');
        res.json({ exito: true, mensaje: 'Reporte guardado con éxito' });
    } catch (error) { await client.query('ROLLBACK'); res.status(500).json({ exito: false, error: 'Error BD' }); } 
    finally { client.release(); }
});

// 4. RUTA PARA RECIBIR Y GUARDAR EL PDF EN WINDOWS
router.post('/reportes/guardar-pdf', async (req, res) => {
    const { folio, pdfBase64 } = req.body;
    try {
        let base64Puro = pdfBase64.includes(',') ? pdfBase64.split(',')[1] : pdfBase64;
        const fs = require('fs');
        const path = require('path');
        const folderPath = "C:\\UsuarioSOS\\ES SISTEMAS\\Formatos Prueba";
        
        if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });
        const filePath = path.join(folderPath, `Reporte_Folio_${folio}.pdf`);
        fs.writeFileSync(filePath, Buffer.from(base64Puro, 'base64'));
        
        res.json({ exito: true, ruta: filePath });
    } catch (error) { res.status(500).json({ exito: false, error: 'Error escribiendo PDF' }); }
});

module.exports = router;