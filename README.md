# 🚨 C5 - Sistema de Alerta Ciudadana Distribuido

Sistema distribuido de alerta ciudadana tipo C5 con 5 microservicios independientes, ESP32, MQTT, gRPC, WebSockets y PostgreSQL con replicación.

---

## ⚡ Levantar todo el sistema (1 solo comando)

```bash
docker compose up --build
```

> ⚠️ La primera vez tarda ~3-5 minutos en descargar imágenes y construir los servicios.

Para detener:
```bash
docker compose down
```

Para detener y borrar volúmenes (reset completo):
```bash
docker compose down -v
```

---

## 📋 Prerequisitos

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (incluye Docker Compose)
- Git

```bash
git clone <URL_DEL_REPO>
cd c5-alert-system
docker compose up --build
```

---

## 🏗️ Servicios y puertos

| Servicio | Puerto | Descripción |
|---|---|---|
| Nginx (LB) | `8080` | Balanceador de carga para Reception |
| Reception x3 | (interno) | 3 instancias balanceadas |
| Geolocation | (interno) | Procesamiento de coordenadas |
| Priority | `50051` | Clasificación gRPC |
| Notifications | `3004` | WebSocket para operadores |
| History | `3005` | API REST historial |
| Mosquitto MQTT | `1883` | Broker IoT |
| Redis | `6379` | Cola de mensajes |
| PostgreSQL Master | `5432` | Base de datos (escritura) |
| PostgreSQL Réplica | `5433` | Base de datos (lectura) |

---

## 🧪 Probar el sistema

### 1. Verificar que todos los servicios están corriendo

```bash
docker compose ps
```

Todos deben aparecer como `running`.

### 2. Enviar una alerta de prueba (sin ESP32)

```bash
curl -X POST http://localhost:8080/alert \
  -H "Content-Type: application/json" \
  -d '{
    "device_id": "ESP32-TEST",
    "latitude": 20.0527,
    "longitude": -99.3467,
    "emergency_type": "robo_con_violencia"
  }'
```

### 3. Ver notificaciones en tiempo real (WebSocket)

Abre en el navegador una consola JavaScript:
```javascript
const ws = new WebSocket("ws://localhost:3004");
ws.onmessage = (e) => console.log("ALERTA:", JSON.parse(e.data));
```

O usa [Postman](https://www.postman.com/) → Nueva solicitud WebSocket → `ws://localhost:3004`

### 4. Consultar el historial

```bash
# Todas las alertas
curl http://localhost:3005/alerts

# Filtrar por prioridad
curl "http://localhost:3005/alerts?priority=critical"

# Filtrar por zona y fecha
curl "http://localhost:3005/alerts?zone=Centro&from=2024-01-01&to=2024-12-31"

# Estadísticas
curl http://localhost:3005/stats
```

### 5. Enviar alerta vía MQTT (simular ESP32)

```bash
# Si tienes mosquitto-clients instalado:
mosquitto_pub -h localhost -p 1883 -t "c5/alerts/panic" \
  -m '{"device_id":"SIM-001","latitude":20.0527,"longitude":-99.3467,"emergency_type":"incendio","timestamp":"2024-06-01T12:00:00Z"}'

# O usando Docker:
docker exec c5_mosquitto mosquitto_pub \
  -t "c5/alerts/panic" \
  -m '{"device_id":"SIM-001","latitude":20.0527,"longitude":-99.3467,"emergency_type":"secuestro","timestamp":"2024-06-01T12:00:00Z"}'
```

---

## 🔥 Demo de tolerancia a fallos

### Demostrar que las alertas NO se pierden si Notifications cae

1. Conecta un cliente WebSocket a `ws://localhost:3004`
2. Detén el servicio de notificaciones:
   ```bash
   docker compose stop notifications
   ```
3. Envía alertas (se encolan en Redis):
   ```bash
   curl -X POST http://localhost:8080/alert -H "Content-Type: application/json" \
     -d '{"device_id":"TEST","latitude":20.05,"longitude":-99.34,"emergency_type":"robo_con_violencia"}'
   ```
4. Verifica que están en Redis:
   ```bash
   docker exec c5_redis redis-cli llen queue:notify_pending
   ```
5. Recupera el servicio:
   ```bash
   docker compose start notifications
   ```
6. Las alertas pendientes se entregan automáticamente al siguiente operador que se conecte.

---

## ⚖️ Demo de balanceo de carga

```bash
# Ver logs de las 3 instancias en tiempo real
docker compose logs -f reception_1 reception_2 reception_3

# En otra terminal, enviar varias alertas
for i in {1..9}; do
  curl -s -X POST http://localhost:8080/alert \
    -H "Content-Type: application/json" \
    -d "{\"device_id\":\"TEST-$i\",\"latitude\":20.05,\"longitude\":-99.34,\"emergency_type\":\"robo\"}" &
done
```

Observa cómo las alertas se distribuyen entre las 3 instancias.

---

## 📱 Configurar ESP32

Ver instrucciones completas en `esp32/README.md`.

Pasos rápidos:
1. Edita `esp32/panic_button.ino` con tu WiFi e IP
2. Flashea con Arduino IDE
3. Abre Monitor Serial (115200 baud)
4. Presiona el botón para enviar alerta

---

## 📁 Estructura del proyecto

```
c5-alert-system/
├── docker-compose.yaml          # ← Levanta TODO el sistema
├── README.md                    # ← Este archivo
├── services/
│   ├── reception/               # Microservicio 1: MQTT + REST
│   ├── geolocation/             # Microservicio 2: Zonas geográficas
│   ├── priority/                # Microservicio 3: Clasificación gRPC
│   ├── notifications/           # Microservicio 4: WebSockets
│   └── history/                 # Microservicio 5: PostgreSQL
├── esp32/
│   ├── panic_button.ino         # Código Arduino para ESP32
│   └── README.md
├── nginx/
│   └── nginx.conf               # Balanceador least_conn
├── mosquitto/
│   └── mosquitto.conf           # Broker MQTT
├── postgres/
│   ├── master-init.sh           # Init BD + tablas + replicación
│   └── replica-init.sh          # Clonar desde master
└── docs/
    ├── architecture.md          # Diagrama de arquitectura
    └── adr/
        ├── ADR-001-redis-queue.md
        ├── ADR-002-grpc-priority.md
        └── ADR-003-postgresql-consistency.md
```

---

## 🩺 Health checks

```bash
curl http://localhost:8080/health          # Nginx → Reception
curl http://localhost:3004/health          # Notifications
curl http://localhost:3005/health          # History
```
