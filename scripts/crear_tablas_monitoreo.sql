-- =========================================================================
-- SOS SERVICIOS MIP - MÓDULO DE MONITOREO DE DISPOSITIVOS (CONTROL Y LUZ)
-- Script SQL para ejecutar en DBeaver / PostgreSQL
-- =========================================================================

-- 1. Agregar columna de subtipo de monitoreo a la tabla 'ordenes_trabajo'
-- Guarda 'Control' o 'Luz' cuando el tipo_servicio es 'Monitoreo'
ALTER TABLE ordenes_trabajo 
ADD COLUMN IF NOT EXISTS subtipo_monitoreo VARCHAR(50);


-- 2. Tabla Maestra: 'dispositivos_cliente'
-- Registra el inventario de dispositivos físicos instalados en cada sucursal/ubicación del cliente.
-- Permite que en visitas posteriores el técnico no tenga que volver a escribir los nombres ni números de dispositivos.
CREATE TABLE IF NOT EXISTS dispositivos_cliente (
    id_dispositivo SERIAL PRIMARY KEY,
    id_ubicacion INT NOT NULL REFERENCES ubicaciones(id_ubicacion) ON DELETE CASCADE,
    tipo_dispositivo VARCHAR(50) NOT NULL,    -- 'Control' (Cebaderas / Trampas) o 'Luz' (Lámparas UV / Insectocutores)
    numero_dispositivo INT NOT NULL,          -- Número correlativo del dispositivo en el sitio (1, 2, 3... 10)
    codigo_dispositivo VARCHAR(50),           -- Código o etiqueta opcional (ej: 'CEB-01', 'LAMP-02')
    area_ubicacion VARCHAR(150),              -- Área física donde está colocado (ej: 'Comedor', 'Almacén Exterior', 'Línea 2')
    tipo_especifico VARCHAR(100),             -- Modelo o tipo (ej: 'Cebadera con rodenticida', 'Lámpara UV 30W con placa')
    activo BOOLEAN DEFAULT true,              -- Indica si el dispositivo sigue instalado y operando
    fecha_instalacion DATE DEFAULT CURRENT_DATE,
    fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_dispositivo_ubicacion UNIQUE (id_ubicacion, tipo_dispositivo, numero_dispositivo)
);

CREATE INDEX IF NOT EXISTS idx_disp_ubicacion ON dispositivos_cliente(id_ubicacion);
CREATE INDEX IF NOT EXISTS idx_disp_tipo ON dispositivos_cliente(tipo_dispositivo);


-- 3. Tabla Transaccional / Histórica: 'monitoreo_lecturas'
-- Almacena la inspección que hace el técnico en cada servicio para cada dispositivo específico.
-- Permite graficar el historial: (ej: Dispositivo 3: Visita 1 = 90%, Visita 2 = 78%, Visita 3 = 34%).
CREATE TABLE IF NOT EXISTS monitoreo_lecturas (
    id_lectura SERIAL PRIMARY KEY,
    id_orden INT NOT NULL REFERENCES ordenes_trabajo(id_orden) ON DELETE CASCADE,
    id_dispositivo INT NOT NULL REFERENCES dispositivos_cliente(id_dispositivo) ON DELETE CASCADE,
    fecha_registro TIMESTAMP DEFAULT timezone('America/Mexico_City', now()),

    -- ========================================================
    -- MÉTRICAS PARA DISPOSITIVOS DE CONTROL (Cebaderas / Trampas)
    -- ========================================================
    consumo_cebo NUMERIC(5,2) DEFAULT 0,            -- Porcentaje de consumo de cebo: 0.00 a 100.00 (%)
    actividad VARCHAR(50),                          -- 'Sin actividad', 'Heces', 'Roeduras', 'Plaga viva', 'Plaga muerta'
    capturas_roedores INT DEFAULT 0,                -- Cantidad de roedores capturados (si aplica trampa mecánica)
    capturas_insectos INT DEFAULT 0,                -- Cantidad de insectos rastreros
    cebo_cambiado BOOLEAN DEFAULT false,            -- ¿Se cambió/limpió el cebo en esta visita?
    estado_dispositivo VARCHAR(50) DEFAULT 'Bueno', -- 'Bueno', 'Dañado', 'Obstruido', 'Extraviado', 'No accesible'

    -- ========================================================
    -- MÉTRICAS PARA DISPOSITIVOS DE LUZ (Lámparas UV / Atrapamoscas)
    -- ========================================================
    captura_moscas INT DEFAULT 0,                   -- Conteo de moscas
    captura_mosquitos INT DEFAULT 0,                -- Conteo de mosquitos / zancudos
    captura_palomillas INT DEFAULT 0,               -- Conteo de palomillas / polillas
    captura_escarabajos INT DEFAULT 0,              -- Conteo de escarabajos / coleópteros
    captura_otros INT DEFAULT 0,                    -- Conteo de otros insectos voladores
    total_capturas INT DEFAULT 0,                   -- Suma total de capturas en la trampa
    estado_lampara VARCHAR(50) DEFAULT 'Operativa', -- 'Operativa', 'Tubo fundido', 'Apagada', 'Requiere limpieza'
    cambio_tubos_uv BOOLEAN DEFAULT false,          -- ¿Se reemplazaron tubos UV en este servicio?
    cambio_placa_adhesiva BOOLEAN DEFAULT false,    -- ¿Se reemplazó la lámina o placa adhesiva?
    porcentaje_saturacion_placa NUMERIC(5,2) DEFAULT 0, -- Porcentaje de saturación visual de la lámina (0 a 100%)

    -- ========================================================
    -- GENERAL
    -- ========================================================
    observaciones TEXT,                             -- Notas o incidencias particulares de este dispositivo
    CONSTRAINT uq_orden_dispositivo UNIQUE (id_orden, id_dispositivo)
);

CREATE INDEX IF NOT EXISTS idx_monitoreo_orden ON monitoreo_lecturas(id_orden);
CREATE INDEX IF NOT EXISTS idx_monitoreo_dispositivo ON monitoreo_lecturas(id_dispositivo);
