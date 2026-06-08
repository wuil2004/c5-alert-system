// services/reception/index.js

const express = require("express");
const mqtt = require("mqtt");
const Redis = require("ioredis");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const INSTANCE_ID = process.env.INSTANCE_ID || "reception_unknown";
const MQTT_BROKER = process.env.MQTT_BROKER || "mqtt://localhost:1883";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const MQTT_TOPIC = "c5/alerts/#";

// ── Redis ──────────────────────────────────────────
const redis = new Redis(REDIS_URL);
redis.on("connect", () => console.log(`[${INSTANCE_ID}] Redis conectado`));
redis.on("error", (err) => console.error(`[${INSTANCE_ID}] Redis error:`, err));

// ── MQTT ───────────────────────────────────────────
const mqttClient = mqtt.connect(MQTT_BROKER);

mqttClient.on("connect", () => {
  console.log(`[${INSTANCE_ID}] MQTT conectado a ${MQTT_BROKER}`);
  mqttClient.subscribe("$share/c5group/" + MQTT_TOPIC, (err) => {
    if (err) console.error(`[${INSTANCE_ID}] Error suscripción MQTT:`, err);
    else console.log(`[${INSTANCE_ID}] Suscrito a grupo compartido: $share/c5group/${MQTT_TOPIC}`);
  });
});

mqttClient.on("message", async (topic, message) => {
  const receivedAt = Date.now();
  console.log(`[${INSTANCE_ID}] Mensaje recibido en ${topic}`);

  try {
    const payload = JSON.parse(message.toString());

    // Validar campos obligatorios
    const required = ["device_id", "latitude", "longitude", "emergency_type"];
    for (const field of required) {
      if (!payload[field]) {
        console.warn(`[${INSTANCE_ID}] Alerta inválida: falta campo ${field}`);
        return;
      }
    }

    const alert = {
      ...payload,
      // Ignoramos el reloj del ESP32 y forzamos la hora y fecha exactas del servidor
      timestamp: new Date().toISOString(),
      received_at: receivedAt,
      processed_by: INSTANCE_ID,
      topic,
    };

    // Encolar en Redis para los demás microservicios
    await redis.lpush("queue:alerts", JSON.stringify(alert));
    console.log(`[${INSTANCE_ID}] Alerta encolada: device=${alert.device_id} tipo=${alert.emergency_type}`);

  } catch (err) {
    console.error(`[${INSTANCE_ID}] Error procesando mensaje:`, err.message);
  }
});

// ── REST API ───────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", instance: INSTANCE_ID, timestamp: new Date().toISOString() });
});

// Endpoint para enviar alerta manual (pruebas sin ESP32)
app.post("/alert", async (req, res) => {
  const alert = {
    ...req.body,
    timestamp: new Date().toISOString(),
    received_at: Date.now(),
    processed_by: INSTANCE_ID,
    source: "http",
  };

  const required = ["device_id", "latitude", "longitude", "emergency_type"];
  for (const field of required) {
    if (!alert[field]) {
      return res.status(400).json({ error: `Campo requerido: ${field}` });
    }
  }

  await redis.lpush("queue:alerts", JSON.stringify(alert));
  res.json({ message: "Alerta recibida", instance: INSTANCE_ID, alert });
});

app.listen(PORT, () => {
  console.log(`[${INSTANCE_ID}] Servidor HTTP escuchando en puerto ${PORT}`);
});
