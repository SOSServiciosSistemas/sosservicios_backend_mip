// database.js
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// Asegurar columna de firma digital en tabla usuarios
pool.query('ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS firma_digital TEXT;')
    .catch(err => console.warn('Aviso al verificar columna firma_digital:', err.message));

// Asegurar columnas de costo y costo_total_tratamiento en ordenes_trabajo para soporte de tratamientos multi-visita
pool.query('ALTER TABLE ordenes_trabajo ADD COLUMN IF NOT EXISTS costo NUMERIC(10,2);')
    .catch(err => console.warn('Aviso al verificar columna costo:', err.message));

pool.query('ALTER TABLE ordenes_trabajo ADD COLUMN IF NOT EXISTS costo_total_tratamiento NUMERIC(10,2);')
    .then(() => {
        // Inicializar costo_total_tratamiento para órdenes grupales existentes que no lo tengan
        return pool.query(`
            UPDATE ordenes_trabajo o
            SET costo_total_tratamiento = sub.costo_inicial
            FROM (
                SELECT id_grupo, MAX(COALESCE(costo, ingresos_cobrados, 0)) AS costo_inicial
                FROM ordenes_trabajo
                WHERE id_grupo IS NOT NULL
                GROUP BY id_grupo
            ) sub
            WHERE o.id_grupo = sub.id_grupo AND (o.costo_total_tratamiento IS NULL OR o.costo_total_tratamiento = 0);
        `);
    })
    .catch(err => console.warn('Aviso al verificar/inicializar costo_total_tratamiento:', err.message));

// Asegurar columna tipo_quimico en productos_insumos
pool.query('ALTER TABLE productos_insumos ADD COLUMN IF NOT EXISTS tipo_quimico VARCHAR(100);')
    .catch(err => console.warn('Aviso al verificar columna tipo_quimico:', err.message));

module.exports = pool;