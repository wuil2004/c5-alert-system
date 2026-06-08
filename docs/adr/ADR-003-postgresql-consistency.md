# ADR-003: Modelo de consistencia PostgreSQL Maestro-Réplica

**Fecha:** 2025-06  
**Estado:** Aceptado

## Contexto

El sistema requiere PostgreSQL con replicación maestro-réplica, con lecturas dirigidas a la réplica. Se debe documentar y justificar el modelo de consistencia elegido.

## Decisión

Se implementa **consistencia eventual** con replicación asíncrona streaming.

- **Escrituras** → PostgreSQL Master (:5432)
- **Lecturas** → PostgreSQL Réplica (:5433)

## Modelo de consistencia: Eventual

### ¿Por qué eventual y no fuerte?

| Criterio | Consistencia Fuerte (síncrona) | Consistencia Eventual (async) ✓ |
|---|---|---|
| Latencia escritura | Alta (espera confirmación réplica) | Baja |
| Disponibilidad | Menor (si réplica falla, bloquea master) | Alta |
| Pérdida de datos | 0 (en caso de crash master) | Pequeño lag |
| Caso de uso | Transacciones financieras | Historial de alertas |

### Justificación para este sistema

El historial de alertas de emergencia es **append-only** y tiene tolerancia a lag de segundos. Lo crítico es que la alerta llegue a los operadores en tiempo real (via WebSocket), no que aparezca instantáneamente en el historial consultable. Un lag de 1-2 segundos en la réplica es completamente aceptable.

## Configuración implementada

```sql
-- En master postgresql.conf
wal_level = replica
max_wal_senders = 3
wal_keep_size = 64
```

```bash
# En réplica: pg_basebackup para clonar del master
```

## Consecuencias

- Las consultas al historial pueden tener un lag de milisegundos a segundos respecto al master
- Si el master cae, la réplica puede ser promovida a master (failover manual)
- El balanceo de lecturas reduce carga en el master, mejorando performance general
