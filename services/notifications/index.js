// services/notifications/index.js
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const Redis = require("ioredis");

const app = express();
app.use(express.json());

const PORT      = process.env.PORT      || 3004;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

const redis     = new Redis(REDIS_URL);
const redisPub  = new Redis(REDIS_URL);
const redisSub  = new Redis(REDIS_URL);  // canal de transcripción

const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ── WebSocket connections ──────────────────────────
const operators = new Set();

wss.on("connection", (ws, req) => {
  operators.add(ws);
  console.log(`[Notifications] Operador conectado. Total: ${operators.size}`);

  ws.send(JSON.stringify({
    type: "connected",
    message: "Conectado al sistema C5 de alertas",
    timestamp: new Date().toISOString(),
  }));

  ws.on("close", () => {
    operators.delete(ws);
    console.log(`[Notifications] Operador desconectado. Total: ${operators.size}`);
  });

  ws.on("error", (err) => {
    console.error("[Notifications] WebSocket error:", err.message);
    operators.delete(ws);
  });
});

// Reenviar alertas pendientes cuando se conecta un operador
wss.on("connection", async (ws) => {
  const pending = await redis.llen("queue:notify_pending");
  if (pending > 0) {
    console.log(`[Notifications] Enviando ${pending} alertas pendientes al nuevo operador`);
    const items = await redis.lrange("queue:notify_pending", 0, -1);
    for (const item of items) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "pending_alert", data: JSON.parse(item) }));
      }
    }
    await redis.del("queue:notify_pending");
  }
});

// ── Broadcast a todos los operadores ──────────────
function broadcastToOperators(type, data) {
  const message = JSON.stringify({ type, data });
  let sent = 0;
  for (const ws of operators) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
      sent++;
    }
  }
  console.log(`[Notifications] [${type}] enviado a ${sent} operador(es)`);
  return sent;
}

// ── Procesador de cola Redis (alertas) ────────────
async function processQueue() {
  console.log("[Notifications] Escuchando cola queue:notify...");
  while (true) {
    try {
      const result = await redis.brpop("queue:notify", 5);
      if (!result) continue;

      const alert = JSON.parse(result[1]);
      const delivered = broadcastToOperators("alert", alert);

      if (delivered === 0) {
        await redisPub.lpush("queue:notify_pending", JSON.stringify(alert));
        console.log(`[Notifications] Sin operadores — alerta guardada en pendientes`);
      }
    } catch (err) {
      console.error("[Notifications] Error procesando:", err.message);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// ── Suscripción a transcripciones ─────────────────
redisSub.subscribe("channel:transcription", (err) => {
  if (err) {
    console.error("[Notifications] Error suscribiéndose a transcripción:", err.message);
  } else {
    console.log("[Notifications] Suscrito a channel:transcription");
  }
});

redisSub.on("message", (channel, message) => {
  if (channel === "channel:transcription") {
    try {
      const data = JSON.parse(message);
      console.log(`[Notifications] Transcripción recibida para alerta ${data.alert_id}`);
      broadcastToOperators("transcription", data);
    } catch (err) {
      console.error("[Notifications] Error procesando transcripción:", err.message);
    }
  }
});

// ── REST API ───────────────────────────────────────
app.get("/health", (req, res) =>
  res.json({ status: "ok", service: "notifications", operators: operators.size })
);

server.listen(PORT, () => {
  console.log(`[Notifications] Servicio iniciado en puerto ${PORT}`);
  console.log(`[Notifications] WebSocket disponible en ws://localhost:${PORT}`);
  processQueue();
});