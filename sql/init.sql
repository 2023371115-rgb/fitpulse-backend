-- FitPulse · Esquema base (MySQL 8+ y MariaDB 10.5+)
-- Las columnas e índices que se agregaron después en bases ya existentes
-- se aplican de forma idempotente desde services/schema.js.

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NULL,
  avatar MEDIUMTEXT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'user',
  weight_kg DECIMAL(5,1) NULL,
  height_cm SMALLINT UNSIGNED NULL,
  age TINYINT UNSIGNED NULL,
  daily_step_goal INT UNSIGNED NOT NULL DEFAULT 10000,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS files (
  id CHAR(36) PRIMARY KEY,
  workspace_id VARCHAR(120) NOT NULL,
  owner_id CHAR(36) NULL,
  original_name TEXT,
  filename VARCHAR(255) NOT NULL,
  mime_type VARCHAR(120),
  size BIGINT,
  storage_path TEXT,
  thumbnail_url TEXT,
  metadata JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_files_workspace_created (workspace_id, created_at),
  CONSTRAINT fk_files_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Dispositivos inteligentes registrados por usuario
CREATE TABLE IF NOT EXISTS devices (
  id CHAR(36) PRIMARY KEY,
  owner_id CHAR(36) NOT NULL,
  name VARCHAR(120) NOT NULL,
  type ENUM('wearable','smarttv','phone','other') NOT NULL DEFAULT 'other',
  status ENUM('idle','linked','offline') NOT NULL DEFAULT 'idle',
  token CHAR(64) NOT NULL,
  pair_code VARCHAR(12) NULL,
  pair_code_expires_at DATETIME NULL,
  battery TINYINT UNSIGNED NULL,
  last_sync_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE INDEX idx_devices_token (token),
  CONSTRAINT fk_devices_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Métricas enviadas por dispositivos (cada registro es una lectura)
CREATE TABLE IF NOT EXISTS metrics (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  device_id CHAR(36) NOT NULL,
  heart_rate SMALLINT UNSIGNED NULL COMMENT 'lpm',
  steps INT UNSIGNED NULL COMMENT 'pasos nuevos desde la lectura anterior',
  spo2 TINYINT UNSIGNED NULL COMMENT 'porcentaje',
  temperature DECIMAL(4,1) NULL COMMENT 'grados C',
  extra JSON NULL COMMENT 'cualquier dato adicional del dispositivo',
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_metrics_device_time (device_id, recorded_at),
  CONSTRAINT fk_metrics_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Metas de salud por usuario
CREATE TABLE IF NOT EXISTS goals (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  type ENUM('steps','calories','heart_rate','weight','sleep','distance','workouts','active') NOT NULL,
  title VARCHAR(120) NULL,
  target DECIMAL(10,2) NOT NULL,
  unit VARCHAR(40) NOT NULL DEFAULT '',
  period ENUM('daily','weekly') NOT NULL DEFAULT 'daily',
  manual_value DECIMAL(10,2) NULL COMMENT 'avance capturado a mano (sueño, peso)',
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_goals_user_created (user_id, created_at),
  CONSTRAINT fk_goals_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Sesiones de entrenamiento por usuario
CREATE TABLE IF NOT EXISTS sessions (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  type ENUM('running','cycling','walking','gym','swimming','other') NOT NULL DEFAULT 'other',
  started_at DATETIME NOT NULL,
  ended_at DATETIME NULL,
  distance_km DECIMAL(6,2) NULL,
  steps INT UNSIGNED NULL,
  calories DECIMAL(10,2) NULL,
  avg_heart_rate SMALLINT UNSIGNED NULL,
  max_heart_rate SMALLINT UNSIGNED NULL,
  hr_samples JSON NULL COMMENT 'ritmo cardiaco muestreado durante la sesion',
  notes TEXT NULL,
  device_name VARCHAR(120) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_sessions_user_started (user_id, started_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Notificaciones para el usuario (metas, sesiones, sincronización, alertas)
CREATE TABLE IF NOT EXISTS notifications (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  kind ENUM('goal','sync','heart','battery','session','tip','ticket') NOT NULL DEFAULT 'tip',
  title VARCHAR(120) NOT NULL,
  body VARCHAR(500) NOT NULL,
  read_at DATETIME NULL,
  created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_notifications_user_created (user_id, created_at),
  CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Reportes de fallos (tickets) enviados desde la app móvil o la web
CREATE TABLE IF NOT EXISTS tickets (
  id CHAR(36) PRIMARY KEY,
  folio INT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE,
  user_id CHAR(36) NULL,
  title VARCHAR(140) NOT NULL,
  description TEXT NOT NULL,
  category ENUM('bug','crash','ui','performance','data','other') NOT NULL DEFAULT 'bug',
  severity ENUM('low','medium','high','critical') NOT NULL DEFAULT 'medium',
  status ENUM('open','in_progress','resolved','closed') NOT NULL DEFAULT 'open',
  screen VARCHAR(80) NULL COMMENT 'pantalla donde ocurrió el fallo',
  platform VARCHAR(40) NULL COMMENT 'android, ios, web, windows…',
  app_version VARCHAR(40) NULL,
  device_info VARCHAR(255) NULL,
  admin_note TEXT NULL,
  created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  resolved_at DATETIME NULL,
  INDEX idx_tickets_user_created (user_id, created_at),
  INDEX idx_tickets_status_created (status, created_at),
  INDEX idx_tickets_rank (status, severity DESC, created_at DESC),
  CONSTRAINT fk_tickets_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Práctica 12 · Claves de idempotencia para escrituras que la app puede reintentar
-- (POST /api/sessions y POST /api/tickets con el encabezado Idempotency-Key).
-- status NULL = la solicitud original sigue en proceso. Se borran a las 24 h.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id CHAR(36) NOT NULL,
  idem_key VARCHAR(80) NOT NULL,
  method VARCHAR(8) NOT NULL,
  path VARCHAR(120) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  status SMALLINT NULL,
  response MEDIUMTEXT NULL,
  created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, idem_key),
  INDEX idx_idempotency_created (created_at)
) ENGINE=InnoDB;
