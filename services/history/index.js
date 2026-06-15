// services/history/index.js

const express = require("express");
const { Pool } = require("pg");
const Redis = require("ioredis");
const https = require("https");
const http  = require("http");
const mqtt  = require("mqtt");

const app = express();
app.use(express.json({ limit: "10mb" }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const PORT      = process.env.PORT      || 3005;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const MQTT_URL  = process.env.MQTT_BROKER || "mqtt://mosquitto:1883";

const CAMARAS = {
  "ESP32-001": "http://192.168.0.105:8080",
  "ESP32-002": "http://192.168.2.192:8080",
  "default":   "http://192.168.0.105:8080",
};

function getCamURL(device_id) {
  return CAMARAS[device_id] || CAMARAS["default"];
}

const masterPool  = new Pool({ connectionString: process.env.DB_MASTER });
const replicaPool = new Pool({ connectionString: process.env.DB_REPLICA });

masterPool.on("connect",  () => console.log("[History] Conectado a PostgreSQL MASTER"));
replicaPool.on("connect", () => console.log("[History] Conectado a PostgreSQL RÉPLICA"));

const redis = new Redis(REDIS_URL);

// ── Cliente MQTT ──────────────────────────────────
let mqttClient;

function conectarMQTT() {
  mqttClient = mqtt.connect(MQTT_URL, { clientId: "c5_history" });
  mqttClient.on("connect", () => console.log("[History] MQTT conectado"));
  mqttClient.on("error",   (err) => console.error("[History] MQTT error:", err.message));
}

// Publicar feedback al ESP32
function notificarESP32(device_id, status) {
  if (!mqttClient || !mqttClient.connected) {
    console.warn("[History] MQTT no conectado — no se pudo notificar al ESP32");
    return;
  }
  const topic   = `c5/alerts/status/${device_id}`;
  const payload = JSON.stringify({ status });
  mqttClient.publish(topic, payload, { qos: 1 }, (err) => {
    if (err) console.error(`[History] Error publicando en ${topic}:`, err.message);
    else     console.log(`[History] Notificado ${device_id} → ${status}`);
  });
}

// ── Capturar foto ─────────────────────────────────
async function capturarSnapshot(device_id) {
  const camURL = getCamURL(device_id);
  const url    = `${camURL}/shot.jpg`;
  return new Promise((resolve) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) { console.warn(`[History] Snapshot falló — status ${res.statusCode}`); return resolve(null); }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(`data:image/jpeg;base64,${Buffer.concat(chunks).toString("base64")}`));
    });
    req.on("error",   (err) => { console.warn(`[History] Error snapshot: ${err.message}`); resolve(null); });
    req.on("timeout", ()    => { req.destroy(); console.warn("[History] Timeout snapshot"); resolve(null); });
  });
}

// ── Migración ─────────────────────────────────────
async function migrateDB() {
  try {
    await masterPool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS snapshot_url TEXT;`);
    await masterPool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS transcription TEXT;`);
    console.log("[History] Columnas snapshot_url y transcription listas");
  } catch (err) {
    console.error("[History] Error en migración:", err.message);
  }
}

// ── Cola alertas ──────────────────────────────────
async function processQueue() {
  console.log("[History] Escuchando cola queue:history...");
  while (true) {
    try {
      const result = await redis.brpop("queue:history", 5);
      if (!result) continue;
      const alert = JSON.parse(result[1]);

      console.log(`[History] Capturando snapshot para ${alert.device_id}...`);
      const snapshot = await capturarSnapshot(alert.device_id);
      if (snapshot) console.log("[History] Snapshot ✓");
      else          console.warn("[History] Sin snapshot");

      await masterPool.query(
        `INSERT INTO alerts
          (id, device_id, latitude, longitude, emergency_type, priority, zone, status, timestamp, snapshot_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET snapshot_url = EXCLUDED.snapshot_url`,
        [
          alert.alert_id || `ALT-${Date.now()}`,
          alert.device_id, alert.latitude, alert.longitude,
          alert.emergency_type, alert.priority || "medium",
          alert.zone || "Desconocida", "received",
          alert.timestamp, snapshot,
        ]
      );
      console.log(`[History] Alerta guardada: ${alert.alert_id}`);
    } catch (err) {
      console.error("[History] Error guardando alerta:", err.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ── Cola transcripciones ──────────────────────────
async function processTranscriptionQueue() {
  console.log("[History] Escuchando cola queue:transcription_save...");
  while (true) {
    try {
      const result = await redis.brpop("queue:transcription_save", 5);
      if (!result) continue;
      const data = JSON.parse(result[1]);
      await masterPool.query(
        `UPDATE alerts SET transcription = $1 WHERE id = $2`,
        [data.transcription, data.alert_id]
      );
      console.log(`[History] Transcripción guardada para ${data.alert_id}`);
    } catch (err) {
      console.error("[History] Error guardando transcripción:", err.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ── REST API ───────────────────────────────────────

app.get("/health", async (req, res) => {
  try {
    await replicaPool.query("SELECT 1");
    res.json({ status: "ok", service: "history", db: "connected" });
  } catch (e) {
    res.status(500).json({ status: "error", db: e.message });
  }
});

app.get("/alerts", async (req, res) => {
  try {
    const { from, to, zone, priority, device_id, status, limit = 50, offset = 0 } = req.query;
    const conditions = []; const values = []; let idx = 1;

    if (from)      { conditions.push(`timestamp >= $${idx++}`); values.push(from); }
    if (to)        { conditions.push(`timestamp <= $${idx++}`); values.push(to); }
    if (zone)      { conditions.push(`zone ILIKE $${idx++}`);   values.push(`%${zone}%`); }
    if (priority)  { conditions.push(`priority = $${idx++}`);   values.push(priority); }
    if (device_id) { conditions.push(`device_id = $${idx++}`);  values.push(device_id); }
    if (status)    { conditions.push(`status = $${idx++}`);     values.push(status); }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const countResult = await replicaPool.query(`SELECT COUNT(*) FROM alerts ${where}`, values);
    const total = parseInt(countResult.rows[0].count);

    const query = `
      SELECT id, device_id, latitude, longitude,
             emergency_type, priority, zone, status,
             timestamp, created_at, snapshot_url, transcription
      FROM alerts ${where}
      ORDER BY timestamp DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `;
    values.push(parseInt(limit)); values.push(parseInt(offset));
    const result = await replicaPool.query(query, values);

    res.json({ total, returned: result.rowCount, limit: parseInt(limit), offset: parseInt(offset), filters: { from, to, zone, priority, device_id, status }, alerts: result.rows, source: "replica" });
  } catch (err) {
    console.error("[History] Error en GET /alerts:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch("/alerts/:id/status", async (req, res) => {
  try {
    // 1. Extraemos el device_id del body
    const { status, device_id } = req.body; 
    const allowed = ["confirmed", "false_alarm", "received", "reviewing"];
    
    if (!allowed.includes(status))
      return res.status(400).json({ error: `Status inválido. Permitidos: ${allowed.join(", ")}` });

    // 2. Lógica para "reviewing"
    if (status === "reviewing") {
      // Si el frontend nos manda el ID, disparamos MQTT directo y sin demoras
      if (device_id) {
        notificarESP32(device_id, "reviewing");
      } else {
        // Fallback por si acaso
        const alertResult = await replicaPool.query(
          "SELECT device_id FROM alerts WHERE id = $1", [req.params.id]
        );
        if (alertResult.rowCount > 0) {
          notificarESP32(alertResult.rows[0].device_id, "reviewing");
        }
      }
      return res.json({ message: "ESP32 notificado — en revisión" });
    }

    // 3. Lógica para "confirmed" y "false_alarm"
    const result = await masterPool.query(
      "UPDATE alerts SET status = $1 WHERE id = $2 RETURNING *",
      [status, req.params.id]
    );

    // Si la BD aún no tiene el registro pero el operador ya resolvió,
    // garantizamos que el hardware responda usando el device_id
    if (result.rowCount === 0) {
      if (device_id) notificarESP32(device_id, status);
      return res.status(200).json({ message: "ESP32 notificado (BD pendiente)" });
    }

    const alerta = result.rows[0];
    console.log(`[History] Alerta ${req.params.id} actualizada → ${status}`);

    if (alerta.device_id) notificarESP32(alerta.device_id, status);

    res.json({ message: "Status actualizado", alert: alerta });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/alerts/:id", async (req, res) => {
  try {
    const result = await replicaPool.query("SELECT * FROM alerts WHERE id = $1", [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Alerta no encontrada" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/stats", async (req, res) => {
  try {
    const totales = await replicaPool.query(`
      SELECT
        COUNT(*)                                        AS total,
        COUNT(*) FILTER (WHERE priority = 'critical')  AS critical,
        COUNT(*) FILTER (WHERE priority = 'high')      AS high,
        COUNT(*) FILTER (WHERE priority = 'medium')    AS medium,
        COUNT(*) FILTER (WHERE status = 'confirmed')   AS confirmed,
        COUNT(*) FILTER (WHERE status = 'false_alarm') AS false_alarm,
        COUNT(*) FILTER (WHERE status = 'received')    AS pending
      FROM alerts
    `);
    const porZona = await replicaPool.query(`
      SELECT zone, COUNT(*) AS total,
        COUNT(*) FILTER (WHERE priority = 'critical') AS critical,
        COUNT(*) FILTER (WHERE priority = 'high')     AS high,
        COUNT(*) FILTER (WHERE priority = 'medium')   AS medium
      FROM alerts GROUP BY zone ORDER BY total DESC LIMIT 10
    `);
    const porDispositivo = await replicaPool.query(`
      SELECT device_id, COUNT(*) AS total FROM alerts GROUP BY device_id ORDER BY total DESC
    `);
    res.json({ totales: totales.rows[0], por_zona: porZona.rows, por_dispositivo: porDispositivo.rows, source: "replica" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, async () => {
  console.log(`[History] Servicio iniciado en puerto ${PORT}`);
  conectarMQTT();
  await migrateDB();
  processQueue();
  processTranscriptionQueue();
});