const express = require('express');
const router = express.Router();
const pool = require('../database');

// Inicialización de la tabla de pagos_servicios si no existe
const initCobranzaDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS pagos_servicios (
                id_pago SERIAL PRIMARY KEY,
                id_orden INT NOT NULL REFERENCES ordenes_trabajo(id_orden) ON DELETE CASCADE,
                id_cliente INT,
                monto NUMERIC(10,2) NOT NULL,
                metodo_pago VARCHAR(50) NOT NULL,
                referencia VARCHAR(150),
                fecha_pago TIMESTAMP DEFAULT timezone('America/Mexico_City', now()),
                id_usuario_registra INT,
                notas TEXT,
                created_at TIMESTAMP DEFAULT timezone('America/Mexico_City', now())
            );
            CREATE INDEX IF NOT EXISTS idx_pagos_orden ON pagos_servicios(id_orden);
        `);
    } catch (err) {
        console.warn("Aviso al verificar tabla pagos_servicios:", err.message);
    }
};
initCobranzaDB();

// 1. OBTENER RESUMEN GENERAL DE COBRANZA Y PAGOS
router.get('/cobranza/resumen', async (req, res) => {
    try {
        // Asegurar que la tabla exista por si acaso
        await initCobranzaDB();

        // Consultar todas las órdenes con datos de clientes, ubicaciones y técnicos
        const queryOrdenes = `
            SELECT o.id_orden, o.id_ubicacion, o.id_tecnico, o.fecha_programada,
                   o.tipo_servicio, o.subtipo_servicio, o.subtipo_monitoreo,
                   o.estatus, o.costo, o.costo_total_tratamiento, o.ingresos_cobrados,
                   o.num_tratamiento, o.total_tratamientos, o.id_grupo, o.requiere_factura,
                   c.id_cliente, c.nombre AS nombre_cliente, c.telefono, c.giro,
                   u.nombre_ubicacion, u.domicilio, u.colonia, u.ciudad,
                   tec.nombre_completo AS nombre_tecnico,
                   r.fecha_reporte,
                   COALESCE(ps.total_pagos, 0) AS total_pagos_registrados,
                   ps.ultimo_pago_fecha,
                   ps.ultimo_pago_metodo,
                   ps.ultimo_pago_ref
            FROM ordenes_trabajo o
            LEFT JOIN ubicaciones u ON o.id_ubicacion = u.id_ubicacion
            LEFT JOIN clientes c ON u.id_cliente = c.id_cliente
            LEFT JOIN usuarios tec ON o.id_tecnico = tec.id_usuario
            LEFT JOIN reportes_mip r ON o.id_orden = r.id_orden
            LEFT JOIN (
                SELECT id_orden, 
                       SUM(monto) AS total_pagos,
                       MAX(fecha_pago) AS ultimo_pago_fecha,
                       (ARRAY_AGG(metodo_pago ORDER BY fecha_pago DESC))[1] AS ultimo_pago_metodo,
                       (ARRAY_AGG(referencia ORDER BY fecha_pago DESC))[1] AS ultimo_pago_ref
                FROM pagos_servicios
                GROUP BY id_orden
            ) ps ON o.id_orden = ps.id_orden
            ORDER BY o.fecha_programada DESC;
        `;

        const resOrdenes = await pool.query(queryOrdenes);
        const todasOrdenes = resOrdenes.rows;

        // Mapear grupos multi-tratamiento para calcular balance por grupo
        const gruposInfo = {};
        todasOrdenes.forEach(o => {
            if (o.id_grupo && parseInt(o.total_tratamientos) > 1) {
                if (!gruposInfo[o.id_grupo]) {
                    gruposInfo[o.id_grupo] = {
                        costoTotal: 0,
                        totalPagado: 0,
                        ordenes: []
                    };
                }
                gruposInfo[o.id_grupo].ordenes.push(o);

                const cTotal = parseFloat(o.costo_total_tratamiento || 0);
                if (cTotal > gruposInfo[o.id_grupo].costoTotal) {
                    gruposInfo[o.id_grupo].costoTotal = cTotal;
                }
                if (parseInt(o.num_tratamiento) === 1 && parseFloat(o.costo || 0) > gruposInfo[o.id_grupo].costoTotal) {
                    gruposInfo[o.id_grupo].costoTotal = parseFloat(o.costo);
                }

                const pagadoEnOrden = Math.max(
                    parseFloat(o.total_pagos_registrados || 0),
                    (o.estatus === 'Completado' ? (parseFloat(o.ingresos_cobrados) || 0) : 0)
                );
                gruposInfo[o.id_grupo].totalPagado += pagadoEnOrden;
            }
        });

        // Procesar lista enriquecida de servicios
        let totalUrgenteMonto = 0;
        let totalUrgenteConteo = 0;
        let totalPendienteMonto = 0;
        let totalPendienteConteo = 0;
        let totalCobradoMonto = 0;

        const serviciosProcesados = todasOrdenes.map(o => {
            const esMulti = Boolean(o.id_grupo && parseInt(o.total_tratamientos) > 1);
            let costoCalculado = 0;
            let totalCobradoCalculado = 0;
            let saldoPendienteCalculado = 0;

            if (esMulti && gruposInfo[o.id_grupo]) {
                const g = gruposInfo[o.id_grupo];
                costoCalculado = g.costoTotal || parseFloat(o.costo || o.costo_total_tratamiento || 0);
                totalCobradoCalculado = g.totalPagado;
                saldoPendienteCalculado = Math.max(0, costoCalculado - totalCobradoCalculado);
            } else {
                costoCalculado = parseFloat(o.costo || o.costo_total_tratamiento || o.ingresos_cobrados || 0);
                totalCobradoCalculado = Math.max(
                    parseFloat(o.total_pagos_registrados || 0),
                    parseFloat(o.ingresos_cobrados || 0)
                );
                saldoPendienteCalculado = Math.max(0, costoCalculado - totalCobradoCalculado);
            }

            // Definir estados
            // URGENTE: El servicio ya fue completado/concluido Y aún tiene saldo pendiente > 0
            const esUrgente = (o.estatus === 'Completado' && saldoPendienteCalculado > 0);
            
            // PENDIENTE FUTURO: Servicio programado/confirmado con saldo pendiente
            const esPendienteCobro = (o.estatus === 'Pendiente' || o.estatus === 'Confirmado') && saldoPendienteCalculado > 0;

            let estadoPago = 'Pendiente';
            if (o.estatus === 'Cancelado') {
                estadoPago = 'Cancelado';
            } else if (costoCalculado > 0 && saldoPendienteCalculado === 0) {
                estadoPago = 'Liquidado';
            } else if (esUrgente) {
                estadoPago = 'Urgente';
            } else if (totalCobradoCalculado > 0 && saldoPendienteCalculado > 0) {
                estadoPago = 'Parcial';
            }

            // Acumuladores de KPIs (evitar duplicar montos de grupo en múltiples visitas)
            const esPrimeraVisitaOGrupoUnico = !esMulti || parseInt(o.num_tratamiento) === 1;

            if (esUrgente) {
                if (esPrimeraVisitaOGrupoUnico || !esMulti) {
                    totalUrgenteMonto += saldoPendienteCalculado;
                }
                totalUrgenteConteo++;
            } else if (esPendienteCobro) {
                if (esPrimeraVisitaOGrupoUnico || !esMulti) {
                    totalPendienteMonto += saldoPendienteCalculado;
                }
                totalPendienteConteo++;
            }

            const telStr = (o.telefono && o.telefono.length > 0) ? (Array.isArray(o.telefono) ? o.telefono.join(', ') : o.telefono) : 'N/A';

            return {
                id_orden: o.id_orden,
                folio_display: o.id_orden.toString().padStart(5, '0'),
                id_cliente: o.id_cliente,
                nombre_cliente: o.nombre_cliente || 'N/A',
                telefono: telStr,
                ciudad: o.ciudad || '',
                domicilio: `${o.domicilio || ''}, ${o.colonia || ''}`.trim(),
                tipo_servicio: o.tipo_servicio,
                subtipo: o.subtipo_monitoreo || o.subtipo_servicio || '',
                num_tratamiento: parseInt(o.num_tratamiento) || 1,
                total_tratamientos: parseInt(o.total_tratamientos) || 1,
                es_multitratamiento: esMulti,
                id_grupo: o.id_grupo,
                fecha_programada: o.fecha_programada,
                fecha_servicio: o.fecha_reporte || o.fecha_programada,
                estatus: o.estatus,
                costo_total: costoCalculado,
                total_cobrado: totalCobradoCalculado,
                saldo_pendiente: saldoPendienteCalculado,
                es_urgente: esUrgente,
                estado_pago: estadoPago,
                nombre_tecnico: o.nombre_tecnico || 'Sin asignar',
                ultimo_pago_fecha: o.ultimo_pago_fecha,
                ultimo_pago_metodo: o.ultimo_pago_metodo || (o.estatus === 'Completado' && totalCobradoCalculado > 0 ? 'Efectivo en Servicio' : null),
                ultimo_pago_ref: o.ultimo_pago_ref || ''
            };
        });

        // 2. Consultar historial detallado de pagos individuales
        const queryPagos = `
            SELECT p.id_pago, p.id_orden, p.monto, p.metodo_pago, p.referencia, p.fecha_pago, p.notas,
                   c.nombre AS nombre_cliente, o.tipo_servicio, o.num_tratamiento, o.total_tratamientos,
                   u.nombre_completo AS usuario_registra
            FROM pagos_servicios p
            JOIN ordenes_trabajo o ON p.id_orden = o.id_orden
            LEFT JOIN ubicaciones ub ON o.id_ubicacion = ub.id_ubicacion
            LEFT JOIN clientes c ON ub.id_cliente = c.id_cliente
            LEFT JOIN usuarios u ON p.id_usuario_registra = u.id_usuario
            ORDER BY p.fecha_pago DESC;
        `;
        const resPagos = await pool.query(queryPagos);
        const pagosRegistrados = resPagos.rows;

        // Calcular total recaudado en pagos_servicios
        const sumaPagosRegistrados = pagosRegistrados.reduce((sum, p) => sum + (parseFloat(p.monto) || 0), 0);

        // Si hay órdenes completadas con ingresos_cobrados previas a la creación de pagos_servicios, sumarlas
        const resCobradoHistorico = await pool.query(`
            SELECT COALESCE(SUM(o.ingresos_cobrados), 0) AS total_historico
            FROM ordenes_trabajo o
            WHERE o.estatus = 'Completado'
              AND o.id_orden NOT IN (SELECT DISTINCT id_orden FROM pagos_servicios);
        `);
        const cobradoHistorico = parseFloat(resCobradoHistorico.rows[0].total_historico) || 0;
        totalCobradoMonto = sumaPagosRegistrados + cobradoHistorico;

        res.json({
            exito: true,
            kpis: {
                total_urgente_monto: totalUrgenteMonto,
                total_urgente_conteo: totalUrgenteConteo,
                total_pendiente_monto: totalPendienteMonto,
                total_pendiente_conteo: totalPendienteConteo,
                total_cobrado_monto: totalCobradoMonto,
                total_pagos_conteo: pagosRegistrados.length
            },
            servicios: serviciosProcesados,
            pagos: pagosRegistrados
        });

    } catch (error) {
        console.error("Error al obtener resumen de cobranza:", error);
        res.status(500).json({ exito: false, error: error.message });
    }
});

// 2. REGISTRAR PAGO DIRECTO (Oficina, Transferencia, Tarjeta, Depósito)
router.post('/cobranza/registrar-pago', async (req, res) => {
    const { id_orden, monto, metodo_pago, referencia, fecha_pago, notas, id_usuario } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const numMonto = parseFloat(monto);
        if (isNaN(numMonto) || numMonto <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ exito: false, error: 'Monto de pago inválido o menor a cero.' });
        }

        // Consultar orden actual
        const resOrd = await client.query(`
            SELECT o.*, u.id_cliente 
            FROM ordenes_trabajo o 
            LEFT JOIN ubicaciones u ON o.id_ubicacion = u.id_ubicacion 
            WHERE o.id_orden = $1
        `, [id_orden]);

        if (resOrd.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ exito: false, error: 'Orden no encontrada' });
        }

        const orden = resOrd.rows[0];
        const fechaPagoVal = fecha_pago ? new Date(fecha_pago) : new Date();

        // 1. Insertar el pago en pagos_servicios
        await client.query(`
            INSERT INTO pagos_servicios (id_orden, id_cliente, monto, metodo_pago, referencia, fecha_pago, id_usuario_registra, notas)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
            id_orden,
            orden.id_cliente,
            numMonto,
            metodo_pago || 'Transferencia',
            referencia || '',
            fechaPagoVal,
            id_usuario ? parseInt(id_usuario) : null,
            notas || ''
        ]);

        // 2. Actualizar ingresos_cobrados de la orden receptora
        await client.query(`
            UPDATE ordenes_trabajo 
            SET ingresos_cobrados = ingresos_cobrados + $1 
            WHERE id_orden = $2
        `, [numMonto, id_orden]);

        // 3. Si pertenece a un grupo multi-tratamiento, rebalancear las visitas siguientes
        if (orden.id_grupo && parseInt(orden.total_tratamientos) > 1) {
            const idGrupo = orden.id_grupo;

            // Determinar costo total pactado del tratamiento
            let costoTotalTrat = parseFloat(orden.costo_total_tratamiento || 0);
            if (costoTotalTrat <= 0) {
                const resOrd1 = await client.query(`
                    SELECT costo_total_tratamiento, costo 
                    FROM ordenes_trabajo 
                    WHERE id_grupo = $1 AND num_tratamiento = 1
                `, [idGrupo]);
                if (resOrd1.rows.length > 0) {
                    costoTotalTrat = parseFloat(resOrd1.rows[0].costo_total_tratamiento || resOrd1.rows[0].costo || 0);
                }
            }

            // Sumar todo lo recaudado en pagos_servicios para las órdenes de este grupo
            const resPagosGrupo = await client.query(`
                SELECT COALESCE(SUM(p.monto), 0) AS total_pagos
                FROM pagos_servicios p
                JOIN ordenes_trabajo o ON p.id_orden = o.id_orden
                WHERE o.id_grupo = $1
            `, [idGrupo]);

            // Sumar ingresos_cobrados de órdenes completadas
            const resCobradoOrdenes = await client.query(`
                SELECT COALESCE(SUM(ingresos_cobrados), 0) AS total_ordenes
                FROM ordenes_trabajo
                WHERE id_grupo = $1 AND estatus = 'Completado'
            `, [idGrupo]);

            const totalPagadoGrupo = Math.max(
                parseFloat(resPagosGrupo.rows[0].total_pagos) || 0,
                parseFloat(resCobradoOrdenes.rows[0].total_ordenes) || 0
            );

            const nuevoSaldoPendiente = Math.max(0, costoTotalTrat - totalPagadoGrupo);

            // Buscar la siguiente visita pendiente o confirmada en el grupo
            const resSiguiente = await client.query(`
                SELECT id_orden, num_tratamiento
                FROM ordenes_trabajo
                WHERE id_grupo = $1 AND estatus IN ('Pendiente', 'Confirmado')
                ORDER BY num_tratamiento ASC
                LIMIT 1
            `, [idGrupo]);

            if (resSiguiente.rows.length > 0) {
                const sig = resSiguiente.rows[0];
                // A la siguiente orden se le asigna el saldo pendiente restante
                await client.query(`
                    UPDATE ordenes_trabajo 
                    SET ingresos_cobrados = $1 
                    WHERE id_orden = $2
                `, [nuevoSaldoPendiente, sig.id_orden]);

                // A las demás visitas consecutivas se les asigna 0
                await client.query(`
                    UPDATE ordenes_trabajo 
                    SET ingresos_cobrados = 0 
                    WHERE id_grupo = $1 AND estatus IN ('Pendiente', 'Confirmado') AND num_tratamiento > $2
                `, [idGrupo, sig.num_tratamiento]);
            }
        }

        await client.query('COMMIT');
        res.json({ exito: true, mensaje: 'Pago registrado y balance actualizado exitosamente' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error al registrar pago en cobranza:", error);
        res.status(500).json({ exito: false, error: error.message });
    } finally {
        client.release();
    }
});

module.exports = router;
