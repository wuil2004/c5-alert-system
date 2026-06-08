// services/history/index.js

const express = require("express");
const { Pool } = require("pg");
const Redis = require("ioredis");

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

const PORT = process.env.PORT || 3005;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

// ── PostgreSQL: Master (escritura) y Réplica (lectura) ──
const masterPool = new Pool({ connectionString: process.env.DB_MASTER });
const replicaPool = new Pool({ connectionString: process.env.DB_REPLICA });

masterPool.on("connect", () => console.log("[History] Conectado a PostgreSQL MASTER"));
replicaPool.on("connect", () => console.log("[History] Conectado a PostgreSQL RÉPLICA"));

const redis = new Redis(REDIS_URL);

// ── Procesador de cola Redis ───────────────────────
async function processQueue() {
  console.log("[History] Escuchando cola queue:history...");
  while (true) {
    try {
      const result = await redis.brpop("queue:history", 5);
      if (!result) continue;

      const alert = JSON.parse(result[1]);

      // Escribir en MASTER
      await masterPool.query(
        `INSERT INTO alerts
          (id, device_id, latitude, longitude, emergency_type, priority, zone, status, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [
          alert.alert_id || `ALT-${Date.now()}`,
          alert.device_id,
          alert.latitude,
          alert.longitude,
          alert.emergency_type,
          alert.priority || "medium",
          alert.zone || "Desconocida",
          "received",
          alert.timestamp,
        ]
      );

      console.log(`[History] Alerta guardada: ${alert.alert_id} — ${alert.priority?.toUpperCase()}`);
    } catch (err) {
      console.error("[History] Error guardando alerta:", err.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ── REST API (lecturas van a RÉPLICA) ──────────────
app.get("/health", async (req, res) => {
  try {
    await replicaPool.query("SELECT 1");
    res.json({ status: "ok", service: "history", db: "connected" });
  } catch (e) {
    res.status(500).json({ status: "error", db: e.message });
  }
});

// GET /alerts?from=&to=&zone=&priority=&limit=
app.get("/alerts", async (req, res) => {
  try {
    const { from, to, zone, priority, limit = 50 } = req.query;
    const conditions = [];
    const values = [];
    let idx = 1;

    if (from) { conditions.push(`timestamp >= $${idx++}`); values.push(from); }
    if (to)   { conditions.push(`timestamp <= $${idx++}`); values.push(to); }
    if (zone) { conditions.push(`zone ILIKE $${idx++}`);   values.push(`%${zone}%`); }
    if (priority) { conditions.push(`priority = $${idx++}`); values.push(priority); }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const query = `SELECT * FROM alerts ${where} ORDER BY timestamp DESC LIMIT $${idx}`;
    values.push(parseInt(limit));

    // Lectura en RÉPLICA
    const result = await replicaPool.query(query, values);
    res.json({ total: result.rowCount, alerts: result.rows, source: "replica" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /alerts/:id
app.get("/alerts/:id", async (req, res) => {
  try {
    const result = await replicaPool.query(
      "SELECT * FROM alerts WHERE id = $1",
      [req.params.id]
    );
    if (result.rowCount === 0)
      return res.status(404).json({ error: "Alerta no encontrada" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /stats
app.get("/stats", async (req, res) => {
  try {
    const result = await replicaPool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE priority = 'critical') AS critical,
        COUNT(*) FILTER (WHERE priority = 'high') AS high,
        COUNT(*) FILTER (WHERE priority = 'medium') AS medium,
        zone,
        DATE_TRUNC('hour', timestamp) AS hour
      FROM alerts
      GROUP BY zone, hour
      ORDER BY hour DESC
      LIMIT 100
    `);
    res.json({ stats: result.rows, source: "replica" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[History] Servicio iniciado en puerto ${PORT}`);
  processQueue();
});
