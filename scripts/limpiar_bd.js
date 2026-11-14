// scripts/limpiar_bd.js
// Script para resetear los datos de prueba y dejar la base de datos lista para producción
require('dotenv').config();
const pool = require('../database');

async function limpiarBaseDatos() {
    const args = process.argv.slice(2);
    const borrarProductos = args.includes('--borrar-productos') || args.includes('--con-productos');

    // Filtrar flags para obtener argumentos de texto
    const textArgs = args.filter(a => !a.startsWith('--'));
    const adminUser = textArgs[0] || 'admin';
    const adminPass = textArgs[1] || 'admin123';
    const adminNombre = textArgs[2] || 'Administrador General';

    const client = await pool.connect();

    try {
        console.log('\n======================================================');
        console.log('   SOS SERVICIOS - REINICIO DE BASE DE DATOS');
        console.log('======================================================');
        console.log('Iniciando limpieza de tablas de prueba...\n');

        await client.query('BEGIN');

        // 1. Tablas a limpiar
        let tablas = [
            'reportes_mip',
            'control_pagos',
            'ordenes_trabajo',
            'ubicaciones',
            'clientes',
            'bitacoras_diarias',
            'movimientos_inventario',
            'inventario_actual',
            'almacenes',
            'usuarios'
        ];

        if (borrarProductos) {
            tablas.push('productos_insumos');
            console.log('⚠ Se incluirá la eliminación del catálogo de productos e insumos químicos.');
        } else {
            console.log('ℹ Se conservará el catálogo de productos_insumos (para vaciarlo también usa el flag --borrar-productos).');
        }

        const queryTruncate = `TRUNCATE TABLE ${tablas.join(', ')} RESTART IDENTITY CASCADE;`;
        await client.query(queryTruncate);
        console.log('✔ Todas las tablas operativas han sido vaciadas.');
        console.log('✔ Los contadores de ID (folios, órdenes, clientes) se reiniciaron a 1.');

        // 2. Crear Almacén Central obligatorio para inventario
        await client.query(`
            INSERT INTO almacenes (nombre, tipo_almacen) 
            VALUES ('Almacén Central', 'General');
        `);
        console.log('✔ Almacén Central (General) recreado con éxito.');

        // 3. Crear usuario Administrador inicial
        await client.query(`
            INSERT INTO usuarios (nombre_completo, usuario, password_hash, rol, activo)
            VALUES ($1, $2, $3, 'Administrador', true);
        `, [adminNombre, adminUser, adminPass]);

        console.log('\n------------------------------------------------------');
        console.log('✔ Usuario Administrador creado exitosamente:');
        console.log(`   - Nombre:     ${adminNombre}`);
        console.log(`   - Usuario:    ${adminUser}`);
        console.log(`   - Contraseña: ${adminPass}`);
        console.log(`   - Rol:        Administrador`);
        console.log('------------------------------------------------------');

        await client.query('COMMIT');
        console.log('\n Operación finalizada con éxito. El sistema está limpio y listo para arrancar.\n');

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
