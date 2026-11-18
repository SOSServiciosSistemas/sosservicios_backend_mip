// scripts/limpiar_bd.js
// Script para resetear los datos de prueba y dejar la base de datos lista para producción
require('dotenv').config();
const pool = require('../database');

async function limpiarBaseDatos() {
    const args = process.argv.slice(2);

    // Credenciales por defecto solicitadas por el usuario
    const adminUser = args[0] || 'veronicanegrete';
    const adminPass = args[1] || 'veroadminsosservicios';
    const adminNombre = args[2] || 'Verónica Negrete';

    const client = await pool.connect();

    try {
        console.log('\n======================================================');
        console.log('   SOS SERVICIOS - REINICIO TOTAL DE BASE DE DATOS');
        console.log('======================================================');
        console.log('Vaciando absolutamente todas las tablas del sistema...\n');

        await client.query('BEGIN');

        // 1. Todas las tablas a vaciar (incluyendo productos, clientes, servicios, inventarios)
        const tablas = [
            'reportes_mip',
            'control_pagos',
            'ordenes_trabajo',
            'ubicaciones',
            'clientes',
            'bitacoras_diarias',
            'movimientos_inventario',
            'inventario_actual',
            'almacenes',
            'productos_insumos',
            'usuarios'
        ];

        const queryTruncate = `TRUNCATE TABLE ${tablas.join(', ')} RESTART IDENTITY CASCADE;`;
        await client.query(queryTruncate);
        console.log('✔ Todas las tablas (servicios, clientes, productos, etc.) han quedado en blanco.');
        console.log('✔ Todos los contadores de folios e IDs se reiniciaron a 1.');

        // 2. Recrear el Almacén Central (necesario para el funcionamiento del módulo de inventario)
        await client.query(`
            INSERT INTO almacenes (nombre, tipo_almacen) 
            VALUES ('Almacén Central', 'General');
        `);
        console.log('✔ Almacén Central (General) listo para inventarios.');

        // 3. Crear el único usuario Administrador
        await client.query(`
            INSERT INTO usuarios (nombre_completo, usuario, password_hash, rol, activo)
            VALUES ($1, $2, $3, 'Administrador', true);
        `, [adminNombre, adminUser, adminPass]);

        console.log('\n------------------------------------------------------');
        console.log('✔ Único usuario registrado en el sistema:');
        console.log(`   - Nombre:     ${adminNombre}`);
        console.log(`   - Usuario:    ${adminUser}`);
        console.log(`   - Contraseña: ${adminPass}`);
        console.log(`   - Rol:        Administrador`);
        console.log('------------------------------------------------------');

        await client.query('COMMIT');
        console.log('\n Éxito: La base de datos está totalmente en blanco y lista para operar.\n');

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('\n❌ Ocurrió un error al limpiar la base de datos:', error.message);
    } finally {
        client.release();
        await pool.end();
        process.exit(0);
    }
}

limpiarBaseDatos();
