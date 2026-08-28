require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();

// Configura los middlewares de la aplicación
app.use(cors());
app.use(express.json());

// Configura la conexión a la base de datos PostgreSQL
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// =================================================================================
// RUTAS DE SISTEMA Y AUTENTICACIÓN
// =================================================================================

// Define la ruta de prueba para verificar la conexión a la base de datos
app.get('/api/test-db', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW() AS hora_actual, current_database() AS nombre_bd');
        res.json({ 
            mensaje: '¡Conexión exitosa a PostgreSQL!', 
            datos: result.rows[0]
        });
    } catch (error) {
        console.error('Error en la conexión:', error);
        res.status(500).json({ error: 'No se pudo conectar a la base de datos' });
    }
});

// Autentica al usuario en el sistema
app.post('/api/login', async (req, res) => {
    const { usuario, password } = req.body;

    try {
        // Busca al usuario en la base de datos
        const result = await pool.query(
            'SELECT id_usuario, nombre_completo, rol FROM usuarios WHERE usuario = $1 AND password_hash = $2 AND activo = true',
            [usuario, password]
        );

        if (result.rows.length > 0) {
            // Devuelve los datos y el rol si las credenciales coinciden
            res.json({
                exito: true,
                mensaje: 'Bienvenido',
                usuario: result.rows[0]
            });
        } else {
            // Retorna error de autenticación si las credenciales son incorrectas
            res.status(401).json({ exito: false, error: 'Usuario o contraseña incorrectos' });
        }
    } catch (error) {
        console.error('Error en el login:', error);
        res.status(500).json({ exito: false, error: 'Error interno del servidor' });
    }
});

// Obtiene la lista de técnicos activos
app.get('/api/tecnicos', async (req, res) => {
    try {
        const query = `SELECT id_usuario, nombre_completo FROM usuarios WHERE rol = 'Tecnico' AND activo = true ORDER BY nombre_completo ASC;`;
        const result = await pool.query(query);
        res.json({ exito: true, tecnicos: result.rows });
    } catch (error) {
        console.error('Error al obtener técnicos:', error);
        res.status(500).json({ exito: false, error: 'Error en la base de datos' });
    }
});

// =================================================================================
// RUTAS DE CLIENTES Y UBICACIONES
// =================================================================================

// Obtiene el directorio general de clientes
app.get('/api/clientes', async (req, res) => {
    try {
        // Utiliza una subconsulta con 'string_agg' para concatenar las ubicaciones y enviarlas al buscador
        const query = `
            SELECT 
                c.id_cliente, c.nombre, c.telefono, c.correo, c.clase,
                (SELECT string_agg(domicilio || ' ' || colonia || ' ' || ciudad, ' | ') 
                 FROM ubicaciones u WHERE u.id_cliente = c.id_cliente) AS direcciones
            FROM clientes c 
            ORDER BY c.nombre ASC;
        `;
        const result = await pool.query(query);
        res.json({ exito: true, clientes: result.rows });
    } catch (error) {
        console.error('Error al obtener clientes:', error);
        res.status(500).json({ exito: false, error: 'Error al consultar clientes' });
    }
});

// Crea un nuevo cliente mediante una transacción completa
app.post('/api/clientes', async (req, res) => {
    const { nombre, contacto, telefono, clase, frecuencia, giro, correo, razonSocial, rfc, domicilioFiscal, domicilio, colonia, ciudad } = req.body;

    const client = await pool.connect();

    try {
        await client.query('BEGIN'); 

        // Inserta el registro en la tabla de clientes, incluyendo los datos fiscales
        const queryCliente = `
            INSERT INTO clientes (nombre, contacto, telefono, clase, frecuencia, giro, correo, razon_social, rfc, domicilio_fiscal) 
            VALUES ($1, $2, ARRAY[$3]::text[], $4, $5, $6, $7, $8, $9, $10)
            RETURNING id_cliente;
        `;
        const resCliente = await client.query(queryCliente, [nombre, contacto, telefono, clase, frecuencia, giro, correo, razonSocial, rfc, domicilioFiscal]);
        const idNuevoCliente = resCliente.rows[0].id_cliente;

        // Inserta la ubicación principal vinculando el ID del cliente recién creado
        const queryUbicacion = `
            INSERT INTO ubicaciones (id_cliente, nombre_ubicacion, domicilio, colonia, ciudad)
            VALUES ($1, 'Matriz', $2, $3, $4);
        `;
        await client.query(queryUbicacion, [idNuevoCliente, domicilio, colonia, ciudad]);

        // Confirma la transacción si ambas inserciones son exitosas
        await client.query('COMMIT'); 
        
        res.json({ exito: true, mensaje: 'Cliente y ubicación creados correctamente' });
    } catch (error) {
        // Revierte la transacción en caso de error
        await client.query('ROLLBACK'); 
        console.error('Error en la transacción de cliente:', error);
        res.status(500).json({ exito: false, error: 'Error al guardar datos completos en la base de datos' });
    } finally {
        // Libera la conexión para evitar la saturación del pool
        client.release(); 
    }
});

// Obtiene los detalles de un cliente específico
app.get('/api/clientes/:id', async (req, res) => {
    const idCliente = req.params.id;
    try {
        const query = `SELECT * FROM clientes WHERE id_cliente = $1;`;
        const result = await pool.query(query, [idCliente]);
        
        if(result.rows.length > 0) {
            res.json({ exito: true, cliente: result.rows[0] });
        } else {
            res.status(404).json({ exito: false, error: 'Cliente no encontrado' });
        }
    } catch (error) {
        console.error('Error al obtener detalle del cliente:', error);
        res.status(500).json({ exito: false, error: 'Error en la base de datos' });
    }
});

// Actualiza los datos de un cliente existente
app.put('/api/clientes/:id', async (req, res) => {
    const idCliente = req.params.id;
    const { contacto, telefono, clase, frecuencia, giro, correo, razonSocial, rfc, domicilioFiscal } = req.body;

    try {
        // Aplica restricción de seguridad omitiendo la columna "nombre" en la actualización
        const query = `
            UPDATE clientes 
            SET contacto = $1, 
                telefono = ARRAY[$2]::text[], 
                clase = $3, 
                frecuencia = $4, 
                giro = $5, 
                correo = $6, 
                razon_social = $7, 
                rfc = $8, 
                domicilio_fiscal = $9
            WHERE id_cliente = $10
            RETURNING id_cliente;
        `;
        
        await pool.query(query, [contacto, telefono, clase, frecuencia, giro, correo, razonSocial, rfc, domicilioFiscal, idCliente]);
        
        res.json({ exito: true, mensaje: 'Cliente actualizado correctamente' });
    } catch (error) {
        console.error('Error al actualizar cliente:', error);
        res.status(500).json({ exito: false, error: 'Error al actualizar en la base de datos' });
    }
});

// Añade una nueva ubicación a un cliente
app.post('/api/ubicaciones', async (req, res) => {
    const { id_cliente, nombre_ubicacion, domicilio, colonia, ciudad } = req.body;
    
    try {
        const query = `
            INSERT INTO ubicaciones (id_cliente, nombre_ubicacion, domicilio, colonia, ciudad)
            VALUES ($1, $2, $3, $4, $5) 
            RETURNING id_ubicacion;
        `;
        const result = await pool.query(query, [id_cliente, nombre_ubicacion, domicilio, colonia, ciudad]);
        
        res.json({ exito: true, mensaje: 'Ubicación añadida con éxito', id_ubicacion: result.rows[0].id_ubicacion });
    } catch (error) {
        console.error('Error al añadir ubicación:', error);
        res.status(500).json({ exito: false, error: 'Error en la base de datos al guardar la ubicación' });
    }
});

// Obtiene las ubicaciones registradas de un cliente específico
app.get('/api/ubicaciones/:id_cliente', async (req, res) => {
    const idCliente = req.params.id_cliente;
    try {
        const query = `SELECT id_ubicacion, nombre_ubicacion, domicilio, colonia, ciudad FROM ubicaciones WHERE id_cliente = $1 ORDER BY id_ubicacion ASC;`;
        const result = await pool.query(query, [idCliente]);
        res.json({ exito: true, ubicaciones: result.rows });
    } catch (error) {
        console.error('Error al obtener ubicaciones:', error);
        res.status(500).json({ exito: false, error: 'Error en la base de datos' });
    }
});

// =================================================================================
// RUTAS DE AGENDA Y ÓRDENES DE TRABAJO
// =================================================================================

// Obtiene todas las órdenes para alimentar el calendario principal
app.get('/api/agenda-general', async (req, res) => {
    try {
        const query = `
            SELECT 
                o.id_orden, 
                o.fecha_programada, 
                o.estatus, 
                c.nombre AS nombre_cliente
            FROM ordenes_trabajo o
            JOIN ubicaciones u ON o.id_ubicacion = u.id_ubicacion
            JOIN clientes c ON u.id_cliente = c.id_cliente
        `;
        
        const result = await pool.query(query);
        
        // Mapea los resultados para cumplir con el formato requerido por FullCalendar
        const eventosCalendario = result.rows.map(orden => {
            let colorFondo = '#6c757d'; 
            let icono = '🕒';
            
            // Asigna el color verde si el estatus es Confirmado o Completado
            if (orden.estatus === 'Confirmado' || orden.estatus === 'Completado') {
                colorFondo = '#198754'; 
                icono = '✔';
            } else if (orden.estatus === 'Cancelado') {
                colorFondo = '#dc3545'; 
                icono = '✖';
            }

            return {
                id: orden.id_orden,
                title: `${icono} ${orden.nombre_cliente}`,
                start: orden.fecha_programada, 
                color: colorFondo,
                extendedProps: {
                    estatus: orden.estatus || 'Tentativo'
                }
            };
        });

        // Envía el arreglo directo esperado por la librería del calendario
        res.json(eventosCalendario);
        
    } catch (error) {
        console.error('Error al cargar agenda corporativa:', error);
        res.status(500).json({ error: 'Error en la base de datos' });
    }
});

// Obtiene la agenda del día actual asignada a un técnico específico
app.get('/api/agenda/:id', async (req, res) => {
    const idTecnico = req.params.id;

    try {
        // Ajusta la consulta para obtener únicamente los registros del día actual en horario de México
        const query = `
            SELECT 
                o.id_orden, o.fecha_programada, o.tipo_servicio, o.observaciones_mesa, o.estatus,
                c.nombre AS nombre_cliente,
                u.colonia, u.domicilio
            FROM ordenes_trabajo o
            JOIN ubicaciones u ON o.id_ubicacion = u.id_ubicacion
            JOIN clientes c ON u.id_cliente = c.id_cliente
            WHERE o.id_tecnico = $1 
            AND o.estatus IN ('Pendiente', 'Confirmado')
            AND o.fecha_programada::date = timezone('America/Mexico_City', now())::date
            ORDER BY o.fecha_programada ASC;
        `;
        
        const result = await pool.query(query, [idTecnico]);
        res.json({ exito: true, agenda: result.rows });
        
    } catch (error) {
        console.error('Error al cargar agenda:', error);
        res.status(500).json({ exito: false, error: 'Error al consultar la base de datos' });
    }
});

// Obtiene el historial completo de los servicios agendados
app.get('/api/historial-ordenes', async (req, res) => {
    try {
        const query = `
            SELECT 
                o.id_orden, o.fecha_programada, o.tipo_servicio, o.estatus,
                c.nombre AS nombre_cliente,
                u.nombre_completo AS nombre_tecnico,
                ub.domicilio, ub.colonia, ub.ciudad
            FROM ordenes_trabajo o
            JOIN ubicaciones ub ON o.id_ubicacion = ub.id_ubicacion
            JOIN clientes c ON ub.id_cliente = c.id_cliente
            LEFT JOIN usuarios u ON o.id_tecnico = u.id_usuario
            ORDER BY o.fecha_programada ASC;
        `;
        const result = await pool.query(query);
        res.json({ exito: true, historial: result.rows });
    } catch (error) {
        console.error('Error al obtener historial:', error);
        res.status(500).json({ exito: false, error: 'Error en la base de datos' });
    }
});

// Obtiene los detalles de una orden específica por ID
app.get('/api/orden/:id', async (req, res) => {
    const idOrden = req.params.id;
    try {
        const query = `
            SELECT 
                o.*, 
                c.id_cliente, 
                c.nombre AS nombre_cliente, 
                c.telefono,
                u.nombre_ubicacion,
                u.domicilio, 
                u.colonia, 
                u.ciudad
            FROM ordenes_trabajo o
            LEFT JOIN ubicaciones u ON o.id_ubicacion = u.id_ubicacion
            LEFT JOIN clientes c ON u.id_cliente = c.id_cliente
            WHERE o.id_orden = $1
        `;
        const result = await pool.query(query, [idOrden]);

        if (result.rows.length > 0) {
            res.json({ exito: true, orden: result.rows[0] });
        } else {
            res.status(404).json({ exito: false, error: 'Orden no encontrada' });
        }
    } catch (error) {
        console.error('Error al obtener orden:', error);
        res.status(500).json({ exito: false, error: 'Error en el servidor al cargar la orden' });
    }
});

// Crea una nueva orden de servicio o una serie de tratamientos
app.post('/api/ordenes', async (req, res) => {
    const { id_ubicacion, id_tecnico, fecha_programada, tipo_servicio, observaciones_mesa, costo, num_tratamiento, total_tratamientos, frecuencia, plagas_a_tratar } = req.body;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const total = parseInt(total_tratamientos) || 0;
        const inicioTratamiento = parseInt(num_tratamiento) || 0;
        
        // Genera un ID único de grupo si corresponde a una serie de servicios
        const idGrupo = (total > 1) ? Date.now().toString() : null; 
        let fechaActual = new Date(fecha_programada);
        let primerId = null;

        const iteraciones = (total > 1 && tipo_servicio === 'Aplicación') ? (total - inicioTratamiento + 1) : 1;

        for (let i = 0; i < iteraciones; i++) {
            const tratamientoActual = inicioTratamiento + i;
            
            const query = `
                INSERT INTO ordenes_trabajo (
                    id_ubicacion, id_tecnico, fecha_programada, tipo_servicio, 
                    observaciones_mesa, estatus, ingresos_cobrados, num_tratamiento, 
                    total_tratamientos, plagas_a_tratar, id_grupo
                )
                VALUES ($1, $2, $3, $4, $5, 'Pendiente', $6, $7, $8, $9, $10)
                RETURNING id_orden;
            `;
            
            // Asigna las plagas operativas únicamente al primer tratamiento
            const plagas = (tratamientoActual === 1) ? plagas_a_tratar : '[]';

            const result = await client.query(query, [
                id_ubicacion, id_tecnico, fechaActual, tipo_servicio, 
                observaciones_mesa, costo, tratamientoActual, total, plagas, idGrupo
            ]);

            if (i === 0) primerId = result.rows[0].id_orden;

            // Calcula la fecha del siguiente servicio según la frecuencia indicada
            if (frecuencia === 'Semanal') fechaActual.setDate(fechaActual.getDate() + 7);
            else if (frecuencia === 'Quincenal') fechaActual.setDate(fechaActual.getDate() + 15);
            else if (frecuencia === 'Mensual') fechaActual.setMonth(fechaActual.getMonth() + 1);
            else if (frecuencia === 'Bimestral') fechaActual.setMonth(fechaActual.getMonth() + 2);
        }

        await client.query('COMMIT');
        res.json({ exito: true, mensaje: 'Servicio(s) agendado(s) correctamente', id_orden: primerId });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al agendar serie:', error);
        res.status(500).json({ exito: false, error: 'Error al guardar en BD' });
    } finally {
        client.release();
    }
});

// Actualiza los detalles de una orden y sincroniza en cascada
app.put('/api/ordenes/:id', async (req, res) => {
    const idOrden = req.params.id;
    const { id_ubicacion, fecha_programada, id_tecnico, tipo_servicio, costo, observaciones_mesa } = req.body;
    
    try {
        // Obtiene los datos actuales para identificar el grupo de la orden editada
        const resOrden = await pool.query('SELECT id_grupo, num_tratamiento FROM ordenes_trabajo WHERE id_orden = $1', [idOrden]);
        const orden = resOrden.rows[0];

        // Actualiza todos los campos de la orden seleccionada
        const queryActualizar = `
            UPDATE ordenes_trabajo 
            SET id_ubicacion = $1, fecha_programada = $2, id_tecnico = $3, tipo_servicio = $4, costo = $5, observaciones_mesa = $6
            WHERE id_orden = $7
        `;
        await pool.query(queryActualizar, [id_ubicacion, fecha_programada, id_tecnico, tipo_servicio, costo, observaciones_mesa, idOrden]);

        // Aplica la actualización en cascada para órdenes relacionadas
        // Modifica ubicación, tipo de servicio y costo en las órdenes subsecuentes con estatus pendiente
        if (orden && orden.id_grupo) {
            const queryCascada = `
                UPDATE ordenes_trabajo 
                SET id_ubicacion = $1, tipo_servicio = $2, costo = $3 
                WHERE id_grupo = $4 AND num_tratamiento > $5 AND estatus = 'Pendiente'
            `;
            await pool.query(queryCascada, [id_ubicacion, tipo_servicio, costo, orden.id_grupo, orden.num_tratamiento]);
        }
        
        res.json({ exito: true, mensaje: 'Orden editada y consecutivos sincronizados' });
    } catch (error) {
        console.error('Error al editar la orden:', error);
        res.status(500).json({ exito: false, error: 'Error en la base de datos' });
    }
});

// Actualiza el estatus de una orden y aplica el cambio en cascada
app.put('/api/ordenes/:id/estatus', async (req, res) => {
    const idOrden = req.params.id;
    const { estatus } = req.body;
    
    try {
        // Valida la existencia y datos de la orden actual
        const resOrden = await pool.query('SELECT id_grupo, num_tratamiento FROM ordenes_trabajo WHERE id_orden = $1', [idOrden]);
        const orden = resOrden.rows[0];

        // Actualiza el estatus de la orden principal
        await pool.query('UPDATE ordenes_trabajo SET estatus = $1 WHERE id_orden = $2', [estatus, idOrden]);
        
        // Aplica el cambio en cascada para su grupo operativo
        if (orden && orden.id_grupo) {
            if (estatus === 'Cancelado') {
                // Cancela las órdenes subsecuentes con estatus pendiente
                const queryCascada = `UPDATE ordenes_trabajo SET estatus = 'Cancelado' WHERE id_grupo = $1 AND num_tratamiento > $2 AND estatus = 'Pendiente';`;
                await pool.query(queryCascada, [orden.id_grupo, orden.num_tratamiento]);
            } else if (estatus === 'Pendiente' || estatus === 'Confirmado') {
                // Reactiva a estatus pendiente las órdenes subsecuentes canceladas
                const queryReactivar = `UPDATE ordenes_trabajo SET estatus = 'Pendiente' WHERE id_grupo = $1 AND num_tratamiento > $2 AND estatus = 'Cancelado';`;
                await pool.query(queryReactivar, [orden.id_grupo, orden.num_tratamiento]);
            }
        }
        
        res.json({ exito: true, mensaje: `Servicio actualizado a ${estatus}` });
    } catch (error) {
        console.error('Error al actualizar estatus:', error);
        res.status(500).json({ exito: false, error: 'Error en BD' });
    }
});

// Reagenda una orden y reactiva las órdenes subsecuentes canceladas
app.put('/api/ordenes/:id/reagendar', async (req, res) => {
    const idOrden = req.params.id;
    const { fecha_programada } = req.body;
    
    try {
        // Obtiene la información del grupo de la orden
        const resOrden = await pool.query('SELECT id_grupo, num_tratamiento FROM ordenes_trabajo WHERE id_orden = $1', [idOrden]);
        const orden = resOrden.rows[0];

        // Fuerza el estatus a pendiente al reagendar la orden
        const query = `UPDATE ordenes_trabajo SET fecha_programada = $1, estatus = 'Pendiente' WHERE id_orden = $2;`;
        await pool.query(query, [fecha_programada, idOrden]);
        
        // Reactiva en cascada las órdenes subsecuentes canceladas
        if (orden && orden.id_grupo) {
            const queryReactivar = `UPDATE ordenes_trabajo SET estatus = 'Pendiente' WHERE id_grupo = $1 AND num_tratamiento > $2 AND estatus = 'Cancelado';`;
            await pool.query(queryReactivar, [orden.id_grupo, orden.num_tratamiento]);
        }
        
        res.json({ exito: true, mensaje: 'Servicio reagendado y reactivado correctamente' });
    } catch (error) {
        console.error('Error al reagendar:', error);
        res.status(500).json({ exito: false, error: 'Error en la base de datos' });
    }
});

// =================================================================================
// RUTAS DE REPORTES MIP
// =================================================================================

// Obtiene el Reporte MIP vinculado a una orden específica
app.get('/api/reportes-mip/:id_orden', async (req, res) => {
    const idOrden = req.params.id_orden;
    
    try {
        const query = `
            SELECT id_reporte, letra_formato, hora_inicio, hora_fin, detalles_ejecucion, fecha_reporte 
            FROM reportes_mip 
            WHERE id_orden = $1;
        `;
        const result = await pool.query(query, [idOrden]);
        
        if (result.rows.length > 0) {
            res.json({ exito: true, reporte: result.rows[0] });
        } else {
            // Retorna mensaje indicando que el reporte aún no ha sido llenado si no hay resultados
            res.json({ exito: false, mensaje: 'Reporte no encontrado' });
        }
    } catch (error) {
        console.error('Error al obtener reporte MIP:', error);
        res.status(500).json({ exito: false, error: 'Error en la base de datos' });
    }
});

// Registra el Reporte MIP y marca la orden como completada
app.post('/api/reportes', async (req, res) => {
    // Extrae los datos de la petición, considerando posibles valores nulos por caché antiguo
    const { id_orden, letra, hora_inicio, hora_fin, detalles } = req.body;
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
                
        // Implementa validación de caché y errores:
        // Utiliza las horas proporcionadas o asigna la hora actual si vienen vacías para evitar errores en PostgreSQL
        const horaInicioSegura = hora_inicio ? hora_inicio : new Date().toISOString();
        const horaFinSegura = hora_fin ? hora_fin : new Date().toISOString();

        // Registra el reporte utilizando las variables de tiempo validadas
        const queryReporte = `
            INSERT INTO reportes_mip (id_orden, letra_formato, hora_inicio, hora_fin, detalles_ejecucion, fecha_reporte)
            VALUES ($1, $2, $3, $4, $5, timezone('America/Mexico_City', now()))
        `;
        
        await client.query(queryReporte, [
            id_orden, 
            letra, 
            horaInicioSegura, 
            horaFinSegura, 
            JSON.stringify(detalles)
        ]);
        
        // Actualiza el estatus de la orden a completado
        const queryOrden = `
            UPDATE ordenes_trabajo 
            SET estatus = 'Completado' 
            WHERE id_orden = $1
        `;
        await client.query(queryOrden, [id_orden]);
        
        await client.query('COMMIT');
        res.json({ exito: true, mensaje: 'Reporte guardado y orden completada' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al guardar reporte:', error);
        res.status(500).json({ exito: false, error: 'Error al procesar el reporte en BD' });
    } finally {
        client.release();
    }
});

// =================================================================================
// RUTAS PARA LA BITÁCORA DIARIA DEL TÉCNICO
// =================================================================================

// Verifica si existe una jornada pendiente o activa para el técnico

app.get('/api/bitacoras/hoy/:id', async (req, res) => {
    const idTecnico = req.params.id;
    try {
        // REGLA MEJORADA: Solo busca rutas activas ("En_Ruta") o la ruta de HOY.
        // Ignora rutas "Cerradas" de días anteriores para permitir arrancar un día nuevo.
        const query = `
            SELECT id_bitacora, estatus, km_inicial 
            FROM bitacoras_diarias 
            WHERE id_tecnico = $1 
              AND (estatus = 'En_Ruta' OR fecha_jornada = CURRENT_DATE)
            ORDER BY fecha_jornada DESC, id_bitacora DESC
            LIMIT 1
        `;
        const result = await pool.query(query, [idTecnico]);

        if (result.rows.length > 0) {
            res.json({ exito: true, bitacora: result.rows[0] });
        } else {
            res.json({ exito: true, bitacora: null });
        }
    } catch (error) {
        console.error('Error al verificar bitácora:', error);
        res.status(500).json({ exito: false, error: 'Error del servidor al verificar jornada' });
    }
});

// Historial personal de Planeadores para la vista del Técnico

app.get('/api/bitacoras/tecnico/:id_tecnico', async (req, res) => {
    try {
        const query = `
            SELECT id_bitacora, fecha_jornada, estatus
            FROM bitacoras_diarias
            WHERE id_tecnico = $1
            ORDER BY fecha_jornada DESC, id_bitacora DESC;
        `;
        const result = await pool.query(query, [req.params.id_tecnico]);
        res.json({ exito: true, bitacoras: result.rows });
    } catch (error) {
        res.status(500).json({ exito: false, error: 'Error al consultar historial' });
    }
});

// Registra la apertura de una nueva jornada
app.post('/api/bitacoras/abrir', async (req, res) => {
    const { id_tecnico, km_inicial, revision_vehiculo } = req.body;
    try {
        const query = `
            INSERT INTO bitacoras_diarias (id_tecnico, km_inicial, revision_vehiculo, estatus)
            VALUES ($1, $2, $3, 'En_Ruta')
            RETURNING id_bitacora
        `;
        // Guarda el objeto JSON con la revisión de la unidad directamente en la base de datos
        const result = await pool.query(query, [id_tecnico, km_inicial, JSON.stringify(revision_vehiculo)]);
        
        res.json({ exito: true, id_bitacora: result.rows[0].id_bitacora, mensaje: 'Jornada iniciada con éxito' });
    } catch (error) {
        console.error('Error al abrir la jornada:', error);
        res.status(500).json({ exito: false, error: 'Error al registrar el inicio de jornada' });
    }
});

// Inserta una actividad extra o gasto no planeado
app.post('/api/bitacoras/actividad', async (req, res) => {
    const { id_bitacora, hora, descripcion, costo, ingreso, gasto } = req.body;
    try {
        // Estructura el nuevo registro en formato JSON
        const nuevaActividad = { hora, descripcion, costo, ingreso, gasto };

        // Inyecta el nuevo registro al arreglo JSONB existente en la base de datos
        const query = `
            UPDATE bitacoras_diarias 
            SET actividades_extra = actividades_extra || $1::jsonb 
            WHERE id_bitacora = $2
        `;
        await pool.query(query, [JSON.stringify([nuevaActividad]), id_bitacora]);
        
        res.json({ exito: true, mensaje: 'Actividad registrada correctamente' });
    } catch (error) {
        console.error('Error al guardar actividad extra:', error);
        res.status(500).json({ exito: false, error: 'Error al registrar el gasto/actividad' });
    }
});

// Ejecuta el cierre de la ruta del día (Con candado de seguridad)
app.post('/api/bitacoras/cerrar-ruta', async (req, res) => {
    const { id_bitacora, km_final, firma_tecnico } = req.body;
    try {
        // 1. VERIFICACIÓN DE SEGURIDAD (El candado)
        const resCheck = await pool.query('SELECT estatus FROM bitacoras_diarias WHERE id_bitacora = $1', [id_bitacora]);
        if (resCheck.rows.length === 0 || resCheck.rows[0].estatus !== 'En_Ruta') {
            return res.status(400).json({ exito: false, error: 'Esta ruta ya fue cerrada o liquidada anteriormente.' });
        }

        // 2. Proceso de cierre normal
        const firmasJson = JSON.stringify({ tecnico: firma_tecnico });

        const query = `
            UPDATE bitacoras_diarias 
            SET estatus = 'Cerrada_Ruta', km_final = $1, firmas_cierre = $2
            WHERE id_bitacora = $3
        `;
        await pool.query(query, [km_final, firmasJson, id_bitacora]);
        
        res.json({ exito: true, mensaje: 'Ruta terminada con éxito' });
    } catch (error) {
        console.error('Error al cerrar ruta:', error);
        res.status(500).json({ exito: false, error: 'Error al cerrar la ruta' });
    }
});


// Liquida la bitácora guardando la firma de Mesa de Control (Paso B)
app.post('/api/bitacoras/entregar', async (req, res) => {
    const { id_bitacora, firma_responsable, total_entregado } = req.body;
    try {
        // Obtenemos el JSON actual de firmas_cierre para no borrar la del técnico
        const resBitacora = await pool.query('SELECT firmas_cierre FROM bitacoras_diarias WHERE id_bitacora = $1', [id_bitacora]);
        let firmas = resBitacora.rows[0].firmas_cierre || {};
        
        // Agregamos la nueva firma
        firmas.responsable = firma_responsable;

        const query = `
            UPDATE bitacoras_diarias 
            SET estatus = 'Entregada', firmas_cierre = $1::jsonb, total_efectivo_entregado = $2
            WHERE id_bitacora = $3
        `;
        await pool.query(query, [JSON.stringify(firmas), total_entregado, id_bitacora]);
        
        res.json({ exito: true, mensaje: 'Planeador entregado y liquidado con éxito' });
    } catch (error) {
        console.error('Error al liquidar bitácora:', error);
        res.status(500).json({ exito: false, error: 'Error al procesar la entrega' });
    }
});

// =================================================================================
// Generar Resumen para el Planeador de Actividades
// =================================================================================
app.get('/api/bitacoras/resumen/:id_bitacora', async (req, res) => {
    const idBitacora = req.params.id_bitacora;
    try {
        const queryBitacora = `
            SELECT b.*, u.nombre_completo AS nombre_tecnico 
            FROM bitacoras_diarias b
            JOIN usuarios u ON b.id_tecnico = u.id_usuario
            WHERE b.id_bitacora = $1
        `;
        const resBitacora = await pool.query(queryBitacora, [idBitacora]);
        
        // ---> EL ESCUDO: Si no encuentra nada, avisa en lugar de chocar <---
        if (resBitacora.rows.length === 0) {
            return res.status(404).json({ exito: false, error: 'La bitácora solicitada no existe' });
        }
        
        const bitacora = resBitacora.rows[0];

        // Enlaza las órdenes con clientes, reportes_mip (químicos) y control_pagos (costos)
        const queryOrdenes = `
            SELECT o.id_orden, o.fecha_programada, o.tipo_servicio, o.ingresos_cobrados, 
                   c.nombre AS nombre_cliente, r.detalles_ejecucion,
                   cp.costo_con_iva AS costo
            FROM ordenes_trabajo o
            JOIN ubicaciones u ON o.id_ubicacion = u.id_ubicacion
            JOIN clientes c ON u.id_cliente = c.id_cliente
            LEFT JOIN reportes_mip r ON o.id_orden = r.id_orden
            LEFT JOIN control_pagos cp ON o.id_orden = cp.id_orden
            WHERE o.id_tecnico = $1 AND o.fecha_programada::date = $2 AND o.estatus = 'Completado'
            ORDER BY o.fecha_programada ASC;
        `;
        const resOrdenes = await pool.query(queryOrdenes, [bitacora.id_tecnico, bitacora.fecha_jornada]);

        res.json({ exito: true, bitacora: bitacora, servicios: resOrdenes.rows });
    } catch (error) {
        console.error('Error al generar resumen:', error);
        res.status(500).json({ exito: false, error: 'Error al generar el planeador' });
    }
});

// =================================================================================
// Liquida Planeador (Firma de Mesa de Control)
// =================================================================================
app.post('/api/bitacoras/entregar', async (req, res) => {
    const { id_bitacora, firma_responsable, total_entregado } = req.body;
    try {
        // Recupera el JSON actual para conservar la firma del técnico
        const resBitacora = await pool.query('SELECT firmas_cierre FROM bitacoras_diarias WHERE id_bitacora = $1', [id_bitacora]);
        let firmas = resBitacora.rows[0].firmas_cierre || {};
        
        // Añade la firma de la responsable
        firmas.responsable = firma_responsable;

        const query = `
            UPDATE bitacoras_diarias 
            SET estatus = 'Entregada', firmas_cierre = $1::jsonb, total_efectivo_entregado = $2
            WHERE id_bitacora = $3
        `;
        await pool.query(query, [JSON.stringify(firmas), total_entregado, id_bitacora]);
        
        res.json({ exito: true, mensaje: 'Planeador liquidado con éxito' });
    } catch (error) {
        console.error('Error al liquidar bitácora:', error);
        res.status(500).json({ exito: false, error: 'Error al procesar la entrega' });
    }
});

// =================================================================================
// Historial de Bitácoras para Mesa de Control
// =================================================================================
app.get('/api/bitacoras/historial', async (req, res) => {
    try {
        const query = `
            SELECT b.id_bitacora, b.fecha_jornada, u.nombre_completo AS tecnico, 
                   b.estatus, b.total_efectivo_entregado, b.km_inicial, b.km_final
            FROM bitacoras_diarias b
            JOIN usuarios u ON b.id_tecnico = u.id_usuario
            ORDER BY b.fecha_jornada DESC, b.id_bitacora DESC;
        `;
        const result = await pool.query(query);
        res.json({ exito: true, bitacoras: result.rows });
    } catch (error) {
        console.error('Error al obtener historial:', error);
        res.status(500).json({ exito: false, error: 'Error al consultar las bitácoras' });
    }
});

// =================================================================================
// INICIALIZACIÓN DEL SERVIDOR
// =================================================================================

// Inicia el servidor en el puerto especificado
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor de SOS Servicios corriendo en http://localhost:${PORT}`);
});