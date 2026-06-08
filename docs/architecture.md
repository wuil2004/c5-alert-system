# Arquitectura del Sistema C5 - Alerta Ciudadana

## Diagrama de Arquitectura

```
┌─────────────────────────────────────────────────────────────────┐
│                     DISPOSITIVOS IoT                            │
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐                          │
│  │  ESP32 #001  │    │  ESP32 #002  │  ... (más dispositivos)  │
│  │  Botón pánico│    │  Botón pánico│                          │
│  └──────┬───────┘    └──────┬───────┘                          │
└─────────┼───────────────────┼─────────────────────────────────-┘
          │  MQTT (puerto 1883)│
          ▼                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                  BROKER MQTT - Mosquitto                        │
│              Topic: c5/alerts/#                                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │ Suscripción MQTT
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│              NGINX - Balanceador (least_conn) :8080             │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐           │
│  │ Reception #1 │ │ Reception #2 │ │ Reception #3 │           │
│  │    :3001     │ │    :3001     │ │    :3001     │           │
│  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘           │
└─────────┼────────────────┼────────────────┼────────────────────┘
          └────────────────┼────────────────┘
                           │ LPUSH queue:alerts
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      REDIS :6379                                │
│   queue:alerts → queue:geo_processed → queue:notify            │
│                                      → queue:history           │
│   (Tolerancia a fallos: queue:notify_pending)                   │
└──────┬─────────────────────────────┬───────────────────────────┘
       │ BRPOP                       │ BRPOP
       ▼                             ▼
┌──────────────┐              ┌──────────────────────────────────┐
│ Geolocation  │              │         Priority :50051          │
│    :3002     │              │    (gRPC Server + proto)         │
│ REST/OpenAPI │              │  Clasifica: critical/high/medium │
│ Zonas geo    │──────────────►  gRPC contrato priority.proto   │
└──────────────┘   gRPC call  └──────────┬─────────────────────-┘
                                         │ LPUSH queue:notify
                                         │ LPUSH queue:history
                       ┌─────────────────┼──────────────────┐
                       │                 │                  │
                       ▼                 ▼                  ▼
              ┌───────────────┐  ┌───────────────┐  ┌──────────────┐
              │ Notifications │  │    History    │  │   (futuro)   │
              │    :3004      │  │    :3005      │  │              │
              │  WebSockets   │  │  REST API     │  │              │
              └───────┬───────┘  └───────┬───────┘  └──────────────┘
                      │                 │
                      ▼                 ▼
              ┌───────────────┐  ┌──────────────────────────────────┐
              │   Operadores  │  │        PostgreSQL                │
              │  (Dashboard)  │  │  Master :5432 (escritura)        │
              │  ws://:3004   │  │  Réplica :5433 (lectura)        │
              └───────────────┘  └──────────────────────────────────┘
```

## Flujo de datos paso a paso

1. **ESP32** presiona botón → publica JSON en MQTT topic `c5/alerts/panic`
2. **Mosquitto** recibe y distribuye el mensaje a todos los suscriptores
3. **Reception** (una de las 3 instancias, via Nginx) recibe la alerta, la valida y la encola en `Redis queue:alerts`
4. **Geolocation** consume de `queue:alerts`, determina la zona geográfica y pasa a `queue:geo_processed`
5. **Priority** consume de `queue:geo_processed`, clasifica la prioridad (gRPC disponible también) y publica en `queue:notify` y `queue:history`
6. **Notifications** consume de `queue:notify` y hace broadcast via WebSocket a todos los operadores conectados
7. **History** consume de `queue:history` y persiste en PostgreSQL Master; las lecturas van a la Réplica

## Decisiones de Diseño

Ver carpeta `adr/` para los Architecture Decision Records completos.
