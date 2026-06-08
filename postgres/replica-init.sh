#!/bin/bash
set -e

# Esperar a que el master esté listo
until pg_isready -h postgres_master -p 5432 -U c5admin; do
  echo "Esperando al master..."
  sleep 2
done

# Limpiar directorio de datos
rm -rf /var/lib/postgresql/data/*

# Clonar desde el master
PGPASSWORD=replicasecret pg_basebackup \
  -h postgres_master \
  -U replicator \
  -D /var/lib/postgresql/data \
  -P -Xs -R

echo "Réplica configurada correctamente"
