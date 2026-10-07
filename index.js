require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

// Configura los middlewares de la aplicación
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ====================================================================
// IMPORTACIÓN Y ENLACE DE RUTAS MODULARES
// ====================================================================
// Al usar '/api' como base, no rompemos ninguna URL del frontend
app.use('/api', require('./routes/sistema'));
app.use('/api', require('./routes/clientes'));
app.use('/api', require('./routes/ordenes'));
app.use('/api', require('./routes/reportes'));
app.use('/api', require('./routes/bitacoras'));
app.use('/api', require('./routes/admin'));
app.use('/api', require('./routes/inventario'));

// ====================================================================
// INICIALIZACIÓN DEL SERVIDOR
// ====================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor de SOS Servicios corriendo en http://localhost:${PORT}`);
});