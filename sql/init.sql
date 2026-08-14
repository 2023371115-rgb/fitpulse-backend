CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NULL,
  avatar MEDIUMTEXT NULL,
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
  CONSTRAINT fk_files_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE INDEX IF NOT EXISTS idx_files_workspace_created ON files (workspace_id, created_at);

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
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_devices_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_token ON devices (token);

-- Métricas enviadas por dispositivos
CREATE TABLE IF NOT EXISTS metrics (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  device_id CHAR(36) NOT NULL,
  heart_rate SMALLINT UNSIGNED NULL COMMENT 'lpm',
  steps INT UNSIGNED NULL,
  spo2 TINYINT UNSIGNED NULL COMMENT 'porcentaje',
  temperature DECIMAL(4,1) NULL COMMENT 'grados C',
  extra JSON NULL COMMENT 'cualquier dato adicional del dispositivo',
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_metrics_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE INDEX IF NOT EXISTS idx_metrics_device_time ON metrics (device_id, recorded_at);

-- Metas de salud por usuario
CREATE TABLE IF NOT EXISTS goals (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  type ENUM('steps','calories','heart_rate','weight','sleep') NOT NULL,
  target DECIMAL(10,2) NOT NULL,
  unit VARCHAR(40) NOT NULL DEFAULT '',
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_goals_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE INDEX IF NOT EXISTS idx_goals_user_created ON goals (user_id, created_at);

-- Sesiones de entrenamiento por usuario
CREATE TABLE IF NOT EXISTS sessions (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  type ENUM('running','cycling','walking','gym','swimming','other') NOT NULL DEFAULT 'other',
  started_at DATETIME NOT NULL,
  ended_at DATETIME NULL,
  steps INT UNSIGNED NULL,
  calories DECIMAL(10,2) NULL,
  avg_heart_rate SMALLINT UNSIGNED NULL,
  notes TEXT NULL,
  device_name VARCHAR(120) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE INDEX IF NOT EXISTS idx_sessions_user_started ON sessions (user_id, started_at);
