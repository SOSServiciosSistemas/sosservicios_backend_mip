// routes/monitoreo.js
const express = require('express');
const router = express.Router();
const pool = require('../database');

// 1. Obtener el inventario de dispositivos registrados de una ubicación
router.get('/dispositivos/ubicacion/:id_ubicacion', async (req, res) => {
    try {
        const { tipo } = req.query; // 'Control' o 'Luz'
        let query = 'SELECT * FROM dispositivos_cliente WHERE id_ubicacion = $1 AND activo = true';
        const params = [req.params.id_ubicacion];

        if (tipo) {
            query += ' AND tipo_dispositivo = $2';
            params.push(tipo);
        }

        query += ' ORDER BY cordon ASC, numero_dispositivo ASC;';

        const result = await pool.query(query, params);
        res.json({ exito: true, dispositivos: result.rows });
    } catch (error) {
        console.error("Error al obtener dispositivos:", error);
        res.status(500).json({ exito: false, error: 'Error al consultar dispositivos' });
    }
});

// 2. Guardar o actualizar inventario de dispositivos físicos
router.post('/dispositivos', async (req, res) => {
    const { id_ubicacion, dispositivos } = req.body;
    if (!id_ubicacion || !Array.isArray(dispositivos)) {
        return res.status(400).json({ exito: false, error: 'Datos incompletos' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const d of dispositivos) {
            await client.query(`
                INSERT INTO dispositivos_cliente (id_ubicacion, tipo_dispositivo, numero_dispositivo, cordon, area_ubicacion, tipo_especifico, activo)
                VALUES ($1, $2, $3, $4, $5, $6, true)
                ON CONFLICT (id_ubicacion, tipo_dispositivo, numero_dispositivo) 
                DO UPDATE SET cordon = EXCLUDED.cordon, area_ubicacion = EXCLUDED.area_ubicacion, tipo_especifico = EXCLUDED.tipo_especifico, activo = true;
            `, [id_ubicacion, d.tipo_dispositivo || 'Control', d.numero_dispositivo, d.cordon || 1, d.area_ubicacion || '', d.tipo_especifico || '']);
        }
        await client.query('COMMIT');
        res.json({ exito: true, mensaje: 'Dispositivos guardados' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error al guardar dispositivos:", error);
        res.status(500).json({ exito: false, error: error.message });
    } finally {
        client.release();
    }
});

// 3. Guardar Reporte Completo de Dispositivos de Control
router.post('/monitoreo/reporte-control', async (req, res) => {
    const {
        id_orden,
        hora_inicio,
        hora_fin,
        id_tecnico,
        monto_cobrado,
        requiere_factura,
        tipo_pago,
        metodo_pago,
        detalles
    } = req.body;

    if (!id_orden) {
        return res.status(400).json({ exito: false, error: 'Falta id_orden' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Validar que la orden existe y obtener su ubicación
        const resOrden = await client.query('SELECT * FROM ordenes_trabajo WHERE id_orden = $1 FOR UPDATE', [id_orden]);
        if (resOrden.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ exito: false, error: 'Orden no encontrada' });
        }
        const orden = resOrden.rows[0];

        // Obtener firma del técnico si no viene adjunta
        let firmaTecnico = detalles.firma_tecnico;
        if (!firmaTecnico && id_tecnico) {
            const resFirma = await client.query('SELECT firma_digital FROM usuarios WHERE id_usuario = $1', [id_tecnico]);
            if (resFirma.rows.length > 0) firmaTecnico = resFirma.rows[0].firma_digital;
        }

        const metodoPagoFinal = metodo_pago || tipo_pago || (detalles && (detalles.metodo_pago || detalles.tipo_pago)) || 'Efectivo';

        const detallesCompletos = {
            ...detalles,
            tipo_pago: metodoPagoFinal,
            metodo_pago: metodoPagoFinal,
            monto_cobrado: parseFloat(monto_cobrado) || 0,
            firma_tecnico: firmaTecnico
        };

        // Guardar o actualizar en reportes_mip
        const resExisteRep = await client.query('SELECT id_reporte FROM reportes_mip WHERE id_orden = $1', [id_orden]);
        if (resExisteRep.rows.length > 0) {
            await client.query(`
                UPDATE reportes_mip 
                SET letra_formato = 'Control',
                    hora_inicio = COALESCE($1, hora_inicio),
                    hora_fin = COALESCE($2, hora_fin),
                    detalles_ejecucion = $3,
                    fecha_reporte = timezone('America/Mexico_City', now())
                WHERE id_orden = $4
            `, [hora_inicio, hora_fin, JSON.stringify(detallesCompletos), id_orden]);
        } else {
            await client.query(`
                INSERT INTO reportes_mip (id_orden, letra_formato, hora_inicio, hora_fin, detalles_ejecucion, fecha_reporte)
                VALUES ($1, 'Control', $2, $3, $4, timezone('America/Mexico_City', now()))
            `, [id_orden, hora_inicio, hora_fin, JSON.stringify(detallesCompletos)]);
        }

        // Limpiar lecturas previas de esta orden para evitar duplicados si se reenvía
        await client.query('DELETE FROM monitoreo_lecturas WHERE id_orden = $1', [id_orden]);

        // Procesar cordones y dispositivos en monitoreo_lecturas y dispositivos_cliente
        if (detalles.cordones && Array.isArray(detalles.cordones)) {
            for (const cord of detalles.cordones) {
                const numCordon = parseInt(cord.cordon) || 1;
                if (cord.dispositivos && Array.isArray(cord.dispositivos)) {
                    for (const disp of cord.dispositivos) {
                        const numDisp = parseInt(disp.numero_dispositivo);
                        if (!numDisp) continue;

                        // Asegurar dispositivo en catálogo
                        const resDisp = await client.query(`
                            INSERT INTO dispositivos_cliente (id_ubicacion, tipo_dispositivo, numero_dispositivo, cordon, activo)
                            VALUES ($1, 'Control', $2, $3, true)
                            ON CONFLICT (id_ubicacion, tipo_dispositivo, numero_dispositivo) 
                            DO UPDATE SET cordon = EXCLUDED.cordon, activo = true
                            RETURNING id_dispositivo;
                        `, [orden.id_ubicacion, numDisp, numCordon]);

                        const idDispositivo = resDisp.rows[0].id_dispositivo;

                        // Insertar lectura de monitoreo
                        await client.query(`
                            INSERT INTO monitoreo_lecturas (
                                id_orden, id_dispositivo, cordon, numero_dispositivo,
                                tipo_material, consumo_cebo, cambio_material,
                                tipo_plaga, captura, observaciones
                            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);
                        `, [
                            id_orden,
                            idDispositivo,
                            numCordon,
                            numDisp,
                            disp.tipo_material || '',
                            parseFloat(disp.consumo_cebo) || 0,
                            (disp.cambio_material !== undefined && disp.cambio_material !== null) ? String(disp.cambio_material).substring(0, 20) : 'N',
                            disp.tipo_plaga || '',
                            parseInt(disp.captura) || 0,
                            disp.observaciones || ''
                        ]);
                    }
                }
            }
        }

        // Marcar la orden como Completada
        const monto = parseFloat(monto_cobrado) || 0;
        await client.query(`
            UPDATE ordenes_trabajo 
            SET estatus = 'Completado', 
                ingresos_cobrados = $1 
            WHERE id_orden = $2
        `, [monto, id_orden]);

        // Registrar en pagos_servicios si hubo cobro
        if (monto > 0) {
            try {
                await client.query(`
                    INSERT INTO pagos_servicios (id_orden, id_cliente, id_grupo, monto, metodo_pago, referencia, fecha_pago, id_usuario_registra, notas)
                    VALUES ($1, $2, $3, $4, $5, 'Cobro al concluir monitoreo', timezone('America/Mexico_City', now()), $6, 'Cobrado en sitio por técnico')
                `, [id_orden, orden.id_cliente, orden.id_grupo || null, monto, metodoPagoFinal, id_tecnico ? parseInt(id_tecnico) : null]);
            } catch (errP) {
                console.warn("Aviso al registrar monitoreo en pagos_servicios:", errP.message);
            }
        }

        // Actualizar control_pagos si existe
        await client.query(`
            UPDATE control_pagos
            SET monto_pagado = $1,
                requiere_factura = COALESCE($2, requiere_factura),
                fecha_actualizacion = timezone('America/Mexico_City', now())
            WHERE id_orden = $3
        `, [monto, requiere_factura, id_orden]);

        await client.query('COMMIT');
        res.json({ exito: true, mensaje: 'Reporte de Dispositivos de Control guardado exitosamente' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error al guardar reporte de control:", error);
        res.status(500).json({ exito: false, error: error.message });
    } finally {
        client.release();
    }
});

// 4. Obtener datos completos para imprimir el Reporte de Dispositivos de Control
router.get('/monitoreo/reporte-control/:id_orden', async (req, res) => {
    try {
        const idOrden = req.params.id_orden;

        // Datos de la orden, ubicación, cliente y técnico
        const resOrden = await pool.query(`
            SELECT o.id_orden, o.tipo_servicio, o.subtipo_monitoreo, o.subtipo_servicio,
                   o.fecha_programada AS fecha_servicio, o.num_tratamiento, o.total_tratamientos,
                   o.id_grupo, o.costo_total_tratamiento, o.costo AS costo_mesa, o.ingresos_cobrados,
                   o.observaciones_mesa,
                   u.nombre_completo AS nombre_tecnico, u.firma_digital AS firma_tecnico_default,
                   c.nombre AS nombre_cliente, c.contacto AS persona_contacto, c.telefono, c.giro AS giro_comercial,
                   ub.domicilio AS direccion_completa, ub.colonia, ub.ciudad,
                   r.letra_formato, r.hora_inicio, r.hora_fin, r.detalles_ejecucion, r.fecha_reporte,
                   cp.requiere_factura, cp.costo_con_iva, cp.costo_sin_iva
            FROM ordenes_trabajo o
            JOIN ubicaciones ub ON o.id_ubicacion = ub.id_ubicacion
            JOIN clientes c ON ub.id_cliente = c.id_cliente
            LEFT JOIN usuarios u ON o.id_tecnico = u.id_usuario
            LEFT JOIN reportes_mip r ON o.id_orden = r.id_orden
            LEFT JOIN control_pagos cp ON o.id_orden = cp.id_orden
            WHERE o.id_orden = $1;
        `, [idOrden]);

        if (resOrden.rows.length === 0) {
            return res.status(404).json({ exito: false, error: 'Orden no encontrada' });
        }

        const ordenData = resOrden.rows[0];

        // Buscar próximo servicio tentativo
        let proximoServicio = null;
        if (ordenData.id_grupo && ordenData.num_tratamiento && ordenData.total_tratamientos > ordenData.num_tratamiento) {
            const sigTrat = parseInt(ordenData.num_tratamiento) + 1;
            const resProx = await pool.query(`
                SELECT fecha_programada 
                FROM ordenes_trabajo 
                WHERE id_grupo = $1 AND num_tratamiento = $2 
                ORDER BY id_orden ASC LIMIT 1;
            `, [ordenData.id_grupo, sigTrat]);

            if (resProx.rows.length > 0) {
                proximoServicio = resProx.rows[0].fecha_programada;
            }
        }

        if (!proximoServicio) {
            const resProxGeneral = await pool.query(`
                SELECT fecha_programada 
                FROM ordenes_trabajo 
                WHERE id_ubicacion = (SELECT id_ubicacion FROM ordenes_trabajo WHERE id_orden = $1)
                  AND id_orden != $1 
                  AND fecha_programada > $2 
                ORDER BY fecha_programada ASC LIMIT 1;
            `, [idOrden, ordenData.fecha_servicio]);
            if (resProxGeneral.rows.length > 0) {
                proximoServicio = resProxGeneral.rows[0].fecha_programada;
            }
        }

        // Obtener lecturas de dispositivos guardadas en la base de datos
        const resLecturas = await pool.query(`
            SELECT l.*, d.area_ubicacion, d.tipo_especifico, d.codigo_dispositivo
            FROM monitoreo_lecturas l
            LEFT JOIN dispositivos_cliente d ON l.id_dispositivo = d.id_dispositivo
            WHERE l.id_orden = $1
            ORDER BY l.cordon ASC, l.numero_dispositivo ASC;
        `, [idOrden]);

        res.json({
            exito: true,
            orden: ordenData,
            proximo_servicio: proximoServicio,
            lecturas: resLecturas.rows
        });

    } catch (error) {
        console.error("Error al obtener reporte de control:", error);
        res.status(500).json({ exito: false, error: error.message });
    }
});

// 5. Guardar Reporte Completo de Dispositivos de Luz
router.post('/monitoreo/reporte-luz', async (req, res) => {
    const {
        id_orden,
        hora_inicio,
        hora_fin,
        id_tecnico,
        monto_cobrado,
        requiere_factura,
        tipo_pago,
        metodo_pago,
        detalles
    } = req.body;

    if (!id_orden) {
        return res.status(400).json({ exito: false, error: 'Falta id_orden' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Validar que la orden existe y obtener su ubicación
        const resOrden = await client.query('SELECT * FROM ordenes_trabajo WHERE id_orden = $1 FOR UPDATE', [id_orden]);
        if (resOrden.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ exito: false, error: 'Orden no encontrada' });
        }
        const orden = resOrden.rows[0];

        // Obtener firma del técnico si no viene adjunta
        let firmaTecnico = detalles.firma_tecnico;
        if (!firmaTecnico && id_tecnico) {
            const resFirma = await client.query('SELECT firma_digital FROM usuarios WHERE id_usuario = $1', [id_tecnico]);
            if (resFirma.rows.length > 0) firmaTecnico = resFirma.rows[0].firma_digital;
        }

        const metodoPagoFinal = metodo_pago || tipo_pago || (detalles && (detalles.metodo_pago || detalles.tipo_pago)) || 'Efectivo';

        const detallesCompletos = {
            ...detalles,
            tipo_pago: metodoPagoFinal,
            metodo_pago: metodoPagoFinal,
            monto_cobrado: parseFloat(monto_cobrado) || 0,
            firma_tecnico: firmaTecnico
        };

        // Guardar o actualizar en reportes_mip con letra_formato = 'Luz'
        const resExisteRep = await client.query('SELECT id_reporte FROM reportes_mip WHERE id_orden = $1', [id_orden]);
        if (resExisteRep.rows.length > 0) {
            await client.query(`
                UPDATE reportes_mip 
                SET letra_formato = 'Luz',
                    hora_inicio = COALESCE($1, hora_inicio),
                    hora_fin = COALESCE($2, hora_fin),
                    detalles_ejecucion = $3,
                    fecha_reporte = timezone('America/Mexico_City', now())
                WHERE id_orden = $4
            `, [hora_inicio, hora_fin, JSON.stringify(detallesCompletos), id_orden]);
        } else {
            await client.query(`
                INSERT INTO reportes_mip (id_orden, letra_formato, hora_inicio, hora_fin, detalles_ejecucion, fecha_reporte)
                VALUES ($1, 'Luz', $2, $3, $4, timezone('America/Mexico_City', now()))
            `, [id_orden, hora_inicio, hora_fin, JSON.stringify(detallesCompletos)]);
        }

        // Limpiar lecturas previas de esta orden para evitar duplicados si se reenvía
        await client.query('DELETE FROM monitoreo_lecturas WHERE id_orden = $1', [id_orden]);

        // Procesar equipos / lámparas de luz
        const listaEquipos = (detalles && (detalles.equipos || detalles.lamparas || detalles.dispositivos)) || [];
        if (Array.isArray(listaEquipos)) {
            for (const eq of listaEquipos) {
                const numDisp = parseInt(eq.numero_dispositivo) || 1;
                const areaUbicacion = (eq.area_ubicacion || '').trim();

                // Asegurar dispositivo en catálogo tipo 'Luz'
                const resDisp = await client.query(`
                    INSERT INTO dispositivos_cliente (id_ubicacion, tipo_dispositivo, numero_dispositivo, cordon, area_ubicacion, tipo_especifico, activo)
                    VALUES ($1, 'Luz', $2, 1, $3, 'Lámpara de Luz', true)
                    ON CONFLICT (id_ubicacion, tipo_dispositivo, numero_dispositivo) 
                    DO UPDATE SET area_ubicacion = EXCLUDED.area_ubicacion, activo = true
                    RETURNING id_dispositivo;
                `, [orden.id_ubicacion, numDisp, areaUbicacion]);

                const idDispositivo = resDisp.rows[0].id_dispositivo;

                // Total de insectos
                const totalCaptura = parseInt(eq.total_insectos) || 0;
                let cambioMatStr = 'N/A';
                if (eq.cambio_material !== undefined && eq.cambio_material !== null && eq.cambio_material !== '') {
                    cambioMatStr = String(eq.cambio_material).substring(0, 20);
                }

                // Generar texto resumen de plagas detectadas
                const plagasDetectadas = [];
                if (parseInt(eq.md) > 0) plagasDetectadas.push(`MD:${eq.md}`);
                if (parseInt(eq.pm) > 0) plagasDetectadas.push(`PM:${eq.pm}`);
                if (parseInt(eq.ma) > 0) plagasDetectadas.push(`MA:${eq.ma}`);
                if (parseInt(eq.mc) > 0) plagasDetectadas.push(`MC:${eq.mc}`);
                if (parseInt(eq.mf) > 0) plagasDetectadas.push(`MF:${eq.mf}`);
                if (parseInt(eq.pl) > 0) plagasDetectadas.push(`PL:${eq.pl}`);
                if (parseInt(eq.mt) > 0) plagasDetectadas.push(`MT:${eq.mt}`);
                if (parseInt(eq.mdr) > 0) plagasDetectadas.push(`MDR:${eq.mdr}`);
                if (parseInt(eq.ab) > 0) plagasDetectadas.push(`AB:${eq.ab}`);
                if (parseInt(eq.av) > 0) plagasDetectadas.push(`AV:${eq.av}`);
                if (parseInt(eq.mv) > 0) plagasDetectadas.push(`MV:${eq.mv}`);
                if (parseInt(eq.h) > 0) plagasDetectadas.push(`H:${eq.h}`);
                if (parseInt(eq.o) > 0) plagasDetectadas.push(`O:${eq.o}`);

                await client.query(`
                    INSERT INTO monitoreo_lecturas (
                        id_orden, id_dispositivo, cordon, numero_dispositivo,
                        tipo_material, consumo_cebo, cambio_material,
                        tipo_plaga, captura, observaciones
                    ) VALUES ($1, $2, 1, $3, $4, 0, $5, $6, $7, $8);
                `, [
                    id_orden,
                    idDispositivo,
                    numDisp,
                    eq.tipo_material || '1',
                    cambioMatStr,
                    plagasDetectadas.join(', '),
                    totalCaptura,
                    eq.observaciones || ''
                ]);
            }
        }

        // Marcar la orden como Completada
        const monto = parseFloat(monto_cobrado) || 0;
        await client.query(`
            UPDATE ordenes_trabajo 
            SET estatus = 'Completado', 
                ingresos_cobrados = $1 
            WHERE id_orden = $2
        `, [monto, id_orden]);

        // Registrar en pagos_servicios si hubo cobro
        if (monto > 0) {
            try {
                await client.query(`
                    INSERT INTO pagos_servicios (id_orden, id_cliente, id_grupo, monto, metodo_pago, referencia, fecha_pago, id_usuario_registra, notas)
                    VALUES ($1, $2, $3, $4, $5, 'Cobro al concluir monitoreo de luz', timezone('America/Mexico_City', now()), $6, 'Cobrado en sitio por técnico')
                `, [id_orden, orden.id_cliente, orden.id_grupo || null, monto, metodoPagoFinal, id_tecnico ? parseInt(id_tecnico) : null]);
            } catch (errP) {
                console.warn("Aviso al registrar monitoreo de luz en pagos_servicios:", errP.message);
            }
        }

        // Actualizar control_pagos si existe
        await client.query(`
            UPDATE control_pagos
            SET monto_pagado = $1,
                requiere_factura = COALESCE($2, requiere_factura),
                fecha_actualizacion = timezone('America/Mexico_City', now())
            WHERE id_orden = $3
        `, [monto, requiere_factura, id_orden]);

        await client.query('COMMIT');
        res.json({ exito: true, mensaje: 'Reporte de Dispositivos de Luz guardado exitosamente' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error al guardar reporte de luz:", error);
        res.status(500).json({ exito: false, error: error.message });
    } finally {
        client.release();
    }
});

// 6. Obtener datos completos para imprimir el Reporte de Dispositivos de Luz
router.get('/monitoreo/reporte-luz/:id_orden', async (req, res) => {
    try {
        const idOrden = req.params.id_orden;

        // Datos de la orden, ubicación, cliente y técnico
        const resOrden = await pool.query(`
            SELECT o.id_orden, o.tipo_servicio, o.subtipo_monitoreo, o.subtipo_servicio,
                   o.fecha_programada AS fecha_servicio, o.num_tratamiento, o.total_tratamientos,
                   o.id_grupo, o.costo_total_tratamiento, o.costo AS costo_mesa, o.ingresos_cobrados,
                   o.observaciones_mesa,
                   u.nombre_completo AS nombre_tecnico, u.firma_digital AS firma_tecnico_default,
                   c.nombre AS nombre_cliente, c.contacto AS persona_contacto, c.telefono, c.giro AS giro_comercial,
                   ub.domicilio AS direccion_completa, ub.colonia, ub.ciudad,
                   r.letra_formato, r.hora_inicio, r.hora_fin, r.detalles_ejecucion, r.fecha_reporte,
                   cp.requiere_factura, cp.costo_con_iva, cp.costo_sin_iva
            FROM ordenes_trabajo o
            JOIN ubicaciones ub ON o.id_ubicacion = ub.id_ubicacion
            JOIN clientes c ON ub.id_cliente = c.id_cliente
            LEFT JOIN usuarios u ON o.id_tecnico = u.id_usuario
            LEFT JOIN reportes_mip r ON o.id_orden = r.id_orden
            LEFT JOIN control_pagos cp ON o.id_orden = cp.id_orden
            WHERE o.id_orden = $1;
        `, [idOrden]);

        if (resOrden.rows.length === 0) {
            return res.status(404).json({ exito: false, error: 'Orden no encontrada' });
        }

        const ordenData = resOrden.rows[0];

        // Buscar próximo servicio tentativo
        let proximoServicio = null;
        if (ordenData.id_grupo && ordenData.num_tratamiento && ordenData.total_tratamientos > ordenData.num_tratamiento) {
            const sigTrat = parseInt(ordenData.num_tratamiento) + 1;
            const resProx = await pool.query(`
                SELECT fecha_programada 
                FROM ordenes_trabajo 
                WHERE id_grupo = $1 AND num_tratamiento = $2 
                ORDER BY id_orden ASC LIMIT 1;
            `, [ordenData.id_grupo, sigTrat]);

            if (resProx.rows.length > 0) {
                proximoServicio = resProx.rows[0].fecha_programada;
            }
        }

        if (!proximoServicio) {
            const resProxGeneral = await pool.query(`
                SELECT fecha_programada 
                FROM ordenes_trabajo 
                WHERE id_ubicacion = (SELECT id_ubicacion FROM ordenes_trabajo WHERE id_orden = $1)
                  AND id_orden != $1 
                  AND fecha_programada > $2 
                ORDER BY fecha_programada ASC LIMIT 1;
            `, [idOrden, ordenData.fecha_servicio]);
            if (resProxGeneral.rows.length > 0) {
                proximoServicio = resProxGeneral.rows[0].fecha_programada;
            }
        }

        // Obtener lecturas de dispositivos guardadas en la base de datos
        const resLecturas = await pool.query(`
            SELECT l.*, d.area_ubicacion, d.tipo_especifico, d.codigo_dispositivo
            FROM monitoreo_lecturas l
            LEFT JOIN dispositivos_cliente d ON l.id_dispositivo = d.id_dispositivo
            WHERE l.id_orden = $1
            ORDER BY l.numero_dispositivo ASC;
        `, [idOrden]);

        res.json({
            exito: true,
            orden: ordenData,
            proximo_servicio: proximoServicio,
            lecturas: resLecturas.rows
        });

    } catch (error) {
        console.error("Error al obtener reporte de luz:", error);
        res.status(500).json({ exito: false, error: error.message });
    }
});

// 5. Guardar firma del cliente directamente desde el visor del reporte
router.post('/monitoreo/firmar', async (req, res) => {
    const { id_orden, firma_cliente } = req.body;
    if (!id_orden || !firma_cliente) {
        return res.status(400).json({ exito: false, error: 'Faltan parámetros requeridos (id_orden o firma_cliente)' });
    }
    try {
        const resRep = await pool.query('SELECT detalles_ejecucion FROM reportes_mip WHERE id_orden = $1', [id_orden]);
        if (resRep.rows.length === 0) {
            return res.status(404).json({ exito: false, error: 'Reporte no encontrado' });
        }
        const detalles = resRep.rows[0].detalles_ejecucion || {};
        detalles.firma_cliente = firma_cliente;
        await pool.query('UPDATE reportes_mip SET detalles_ejecucion = $1 WHERE id_orden = $2', [JSON.stringify(detalles), id_orden]);
        res.json({ exito: true, mensaje: 'Firma guardada exitosamente' });
    } catch (err) {
        console.error("Error al guardar firma de monitoreo:", err);
        res.status(500).json({ exito: false, error: err.message });
    }
});

module.exports = router;
