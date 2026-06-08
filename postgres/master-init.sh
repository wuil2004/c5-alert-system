#!/bin/bash
set -e

# Crear usuario de replicación
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE USER replicator WITH REPLICATION ENCRYPTED PASSWORD 'replicasecret';
EOSQL

# Configurar pg_hba para replicación
cat >> /var/lib/postgresql/data/pg_hba.conf <<-EOF
host replication replicator 0.0.0.0/0 md5
EOF

# Configurar postgresql.conf para replicación
cat >> /var/lib/postgresql/data/postgresql.conf <<-EOF
wal_level = replica
max_wal_senders = 3
wal_keep_size = 64
EOF

# Crear tabla de alertas
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE TABLE IF NOT EXISTS alerts (
        id VARCHAR(100) PRIMARY KEY,
        device_id VARCHAR(50) NOT NULL,
        latitude DECIMAL(10, 8) NOT NULL,
        longitude DECIMAL(11, 8) NOT NULL,
        emergency_type VARCHAR(50) NOT NULL,
        priority VARCHAR(10) NOT NULL,
        zone VARCHAR(100),
        status VARCHAR(20) DEFAULT 'received',
        timestamp TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX idx_alerts_timestamp ON alerts(timestamp);
    CREATE INDEX idx_alerts_priority ON alerts(priority);
    CREATE INDEX idx_alerts_zone ON alerts(zone);
EOSQL
