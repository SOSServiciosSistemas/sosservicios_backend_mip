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

// Asegurar columnas de costo, costo_total_tratamiento, subtipo_monitoreo y subtipo_servicio en ordenes_trabajo
pool.query('ALTER TABLE ordenes_trabajo ADD COLUMN IF NOT EXISTS costo NUMERIC(10,2);')
    .catch(err => console.warn('Aviso al verificar columna costo:', err.message));

pool.query('ALTER TABLE ordenes_trabajo ADD COLUMN IF NOT EXISTS subtipo_monitoreo VARCHAR(50);')
    .catch(err => console.warn('Aviso al verificar columna subtipo_monitoreo:', err.message));

pool.query('ALTER TABLE ordenes_trabajo ADD COLUMN IF NOT EXISTS subtipo_servicio VARCHAR(50);')
    .catch(err => console.warn('Aviso al verificar columna subtipo_servicio:', err.message));

// Asegurar soporte de cordones y detalle en dispositivos_cliente y monitoreo_lecturas
pool.query(`
    CREATE TABLE IF NOT EXISTS dispositivos_cliente (
        id_dispositivo SERIAL PRIMARY KEY,
        id_ubicacion INT NOT NULL REFERENCES ubicaciones(id_ubicacion) ON DELETE CASCADE,
        tipo_dispositivo VARCHAR(50) NOT NULL,
        numero_dispositivo INT NOT NULL,
        cordon INT DEFAULT 1,
        codigo_dispositivo VARCHAR(50),
        area_ubicacion VARCHAR(150),
        tipo_especifico VARCHAR(100),
        activo BOOLEAN DEFAULT true,
        fecha_instalacion DATE DEFAULT CURRENT_DATE,
        fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_dispositivo_ubicacion UNIQUE (id_ubicacion, tipo_dispositivo, numero_dispositivo)
    );
    ALTER TABLE dispositivos_cliente ADD COLUMN IF NOT EXISTS cordon INT DEFAULT 1;

    CREATE TABLE IF NOT EXISTS monitoreo_lecturas (
        id_lectura SERIAL PRIMARY KEY,
        id_orden INT NOT NULL REFERENCES ordenes_trabajo(id_orden) ON DELETE CASCADE,
        id_dispositivo INT REFERENCES dispositivos_cliente(id_dispositivo) ON DELETE SET NULL,
        cordon INT DEFAULT 1,
        numero_dispositivo INT,
        tipo_material VARCHAR(10),
        consumo_cebo NUMERIC(5,2) DEFAULT 0,
        cambio_material VARCHAR(5) DEFAULT 'N',
        tipo_plaga VARCHAR(50),
        captura INT DEFAULT 0,
        observaciones TEXT,
        fecha_registro TIMESTAMP DEFAULT timezone('America/Mexico_City', now())
    );
    ALTER TABLE monitoreo_lecturas ADD COLUMN IF NOT EXISTS cordon INT DEFAULT 1;
    ALTER TABLE monitoreo_lecturas ADD COLUMN IF NOT EXISTS numero_dispositivo INT;
    ALTER TABLE monitoreo_lecturas ADD COLUMN IF NOT EXISTS tipo_material VARCHAR(10);
    ALTER TABLE monitoreo_lecturas ADD COLUMN IF NOT EXISTS consumo_cebo NUMERIC(5,2) DEFAULT 0;
    ALTER TABLE monitoreo_lecturas ADD COLUMN IF NOT EXISTS cambio_material VARCHAR(5) DEFAULT 'N';
    ALTER TABLE monitoreo_lecturas ADD COLUMN IF NOT EXISTS tipo_plaga VARCHAR(50);
    ALTER TABLE monitoreo_lecturas ADD COLUMN IF NOT EXISTS captura INT DEFAULT 0;
    ALTER TABLE monitoreo_lecturas ADD COLUMN IF NOT EXISTS observaciones TEXT;
`).catch(err => console.warn('Aviso al verificar tablas de monitoreo:', err.message));

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

module.exports = pool;