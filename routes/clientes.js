const express = require('express');
const router = express.Router();
const pool = require('../database');

router.get('/clientes', async (req, res) => {
    try {
        const query = `
            SELECT c.id_cliente, c.nombre, c.telefono, c.correo, c.clase,
                   (SELECT string_agg(domicilio || ' ' || colonia || ' ' || ciudad, ' | ') 
                    FROM ubicaciones u WHERE u.id_cliente = c.id_cliente) AS direcciones
            FROM clientes c ORDER BY c.nombre ASC;
        `;
        const result = await pool.query(query);
        res.json({ exito: true, clientes: result.rows });
    } catch (error) {
        res.status(500).json({ exito: false, error: 'Error al consultar clientes' });
    }
});

router.post('/clientes', async (req, res) => {
    const { nombre, contacto, telefono, clase, frecuencia, giro, correo, razonSocial, rfc, domicilioFiscal, domicilio, colonia, ciudad } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); 
        const resCliente = await client.query(`
            INSERT INTO clientes (nombre, contacto, telefono, clase, frecuencia, giro, correo, razon_social, rfc, domicilio_fiscal) 
            VALUES ($1, $2, ARRAY[$3]::text[], $4, $5, $6, $7, $8, $9, $10) RETURNING id_cliente;
        `, [nombre, contacto, telefono, clase, frecuencia, giro, correo, razonSocial, rfc, domicilioFiscal]);
        
        await client.query(`
            INSERT INTO ubicaciones (id_cliente, nombre_ubicacion, domicilio, colonia, ciudad)
            VALUES ($1, 'Matriz', $2, $3, $4);
        `, [resCliente.rows[0].id_cliente, domicilio, colonia, ciudad]);
        
        await client.query('COMMIT'); 
        res.json({ exito: true, mensaje: 'Cliente y ubicación creados' });
    } catch (error) {
        await client.query('ROLLBACK'); 
        res.status(500).json({ exito: false, error: 'Error al guardar en BD' });
    } finally {
        client.release(); 
    }
});

router.get('/clientes/:id', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM clientes WHERE id_cliente = $1;`, [req.params.id]);
        if(result.rows.length > 0) res.json({ exito: true, cliente: result.rows[0] });
        else res.status(404).json({ exito: false, error: 'Cliente no encontrado' });
    } catch (error) {
        res.status(500).json({ exito: false, error: 'Error BD' });
    }
});

router.put('/clientes/:id', async (req, res) => {
    const { contacto, telefono, clase, frecuencia, giro, correo, razonSocial, rfc, domicilioFiscal } = req.body;
    try {
        await pool.query(`
            UPDATE clientes SET contacto = $1, telefono = ARRAY[$2]::text[], clase = $3, frecuencia = $4, giro = $5, 
            correo = $6, razon_social = $7, rfc = $8, domicilio_fiscal = $9 WHERE id_cliente = $10;
        `, [contacto, telefono, clase, frecuencia, giro, correo, razonSocial, rfc, domicilioFiscal, req.params.id]);
        res.json({ exito: true, mensaje: 'Cliente actualizado' });
    } catch (error) {
        res.status(500).json({ exito: false, error: 'Error BD' });
    }
});

router.post('/ubicaciones', async (req, res) => {
    const { id_cliente, nombre_ubicacion, domicilio, colonia, ciudad } = req.body;
    try {
        const result = await pool.query(`
            INSERT INTO ubicaciones (id_cliente, nombre_ubicacion, domicilio, colonia, ciudad)
            VALUES ($1, $2, $3, $4, $5) RETURNING id_ubicacion;
        `, [id_cliente, nombre_ubicacion, domicilio, colonia, ciudad]);
        res.json({ exito: true, id_ubicacion: result.rows[0].id_ubicacion });
    } catch (error) {
        res.status(500).json({ exito: false, error: 'Error BD' });
    }
});

router.get('/ubicaciones/:id_cliente', async (req, res) => {
    try {
        const result = await pool.query(`SELECT id_ubicacion, nombre_ubicacion, domicilio, colonia, ciudad FROM ubicaciones WHERE id_cliente = $1 ORDER BY id_ubicacion ASC;`, [req.params.id_cliente]);
        res.json({ exito: true, ubicaciones: result.rows });
    } catch (error) {
        res.status(500).json({ exito: false, error: 'Error BD' });
    }
});

module.exports = router;