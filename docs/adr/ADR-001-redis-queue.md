# ADR-001: Uso de Redis como cola de mensajes entre microservicios

**Fecha:** 2025-06  
**Estado:** Aceptado

## Contexto

El sistema necesita comunicación asíncrona entre los 5 microservicios para garantizar que ninguna alerta se pierda, incluso si un servicio cae temporalmente.

## Decisión

Se utiliza **Redis con listas (LPUSH/BRPOP)** como cola de mensajes entre servicios, en lugar de un message broker dedicado (RabbitMQ, Kafka).

## Alternativas consideradas

| Alternativa | Pros | Contras |
|---|---|---|
| **Redis Listas** ✓ | Simple, ya requerido, baja latencia | Sin replay, sin grupos de consumidores nativos |
| RabbitMQ | ACKs, exchanges flexibles | Otro servicio más, configuración compleja |
| Apache Kafka | Replay, alto throughput | Overkill para este scale, complejo |

## Justificación

- Redis ya es parte del stack requerido (caché/cola en memoria)
- La latencia objetivo (<2s end-to-end) se cumple fácilmente con Redis
- El patrón LPUSH/BRPOP garantiza entrega FIFO y que las alertas no se pierden si un consumidor cae (quedan en la lista)
- Para este proyecto académico, la simplicidad favorece la mantenibilidad

## Consecuencias

- Si Redis cae, las alertas en tránsito se pierden (aceptable con restart policy)
- No hay reintentos automáticos nativos (se implementa con queue:notify_pending)
- Modelo de consistencia: **eventual** — las alertas llegan a history con pequeño delay
