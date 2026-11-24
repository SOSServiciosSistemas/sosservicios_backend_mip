const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'sos_servicios_jwt_super_secret_key_2026';

// 1. Middleware para validar que la petición incluya un token JWT válido
const autenticarToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    // Formato estándar: "Bearer <token>"
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ 
            exito: false, 
            error: 'Acceso no autorizado: No se proporcionó token de sesión.' 
        });
    }

    jwt.verify(token, JWT_SECRET, (err, usuarioDecodificado) => {
        if (err) {
            return res.status(401).json({ 
                exito: false, 
                error: 'Token inválido o expirado. Por favor, inicia sesión nuevamente.' 
            });
        }
        req.usuario = usuarioDecodificado; // { id_usuario, rol, nombre_completo, iat, exp }
        next();
    });
};

// 2. Middleware para autorizar acceso únicamente a ciertos roles
const autorizarRoles = (...rolesPermitidos) => {
    return (req, res, next) => {
        if (!req.usuario) {
            return res.status(401).json({ exito: false, error: 'Usuario no autenticado.' });
        }

        const rolUsuario = req.usuario.rol;
        const tienePermiso = rolesPermitidos.some(rol => {
            if (rol === 'Admin' || rol === 'Administrador') {
                return rolUsuario === 'Admin' || rolUsuario === 'Administrador';
            }
            return rolUsuario === rol;
        });

        if (!tienePermiso) {
            return res.status(403).json({ 
                exito: false, 
                error: `Acceso denegado: Tu rol (${rolUsuario}) no tiene permisos para esta acción.` 
            });
        }

        next();
    };
};

module.exports = {
    autenticarToken,
    autorizarRoles,
    JWT_SECRET
};
