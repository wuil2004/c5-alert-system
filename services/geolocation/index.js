// services/geolocation/index.js

const express = require("express");
const Redis = require("ioredis");
const https = require("https");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3002;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

const redis = new Redis(REDIS_URL);
const redisPub = new Redis(REDIS_URL);

// ── Cache en memoria para no sobrecargar Nominatim ────
// (Nominatim pide máximo 1 req/segundo por su política de uso)
const geoCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

// ── Consultar Nominatim (OpenStreetMap) ───────────────
// Documentación: https://nominatim.org/release-docs/develop/api/Reverse/
function reverseGeocode(lat, lon) {
  return new Promise((resolve) => {
    const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    const cached = geoCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      console.log(`[Geolocation] Cache hit: ${cacheKey}`);
      return resolve(cached.data);
    }

    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1&accept-language=es`;

    const options = {
      headers: {
        // Nominatim REQUIERE User-Agent identificando tu app
        "User-Agent": "C5-AlertaCiudadana/1.0 (sistema-escolar@example.com)"
      }
    };

    https.get(url, options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const addr = json.address || {};

          const result = {
            // Dirección completa legible
            display_name: json.display_name || "Dirección desconocida",

            // Componentes individuales
            street:       addr.road || addr.pedestrian || addr.path || null,
            neighborhood: addr.neighbourhood || addr.suburb || addr.quarter || null,
            city:         addr.city || addr.town || addr.village || addr.municipality || null,
            state:        addr.state || null,
            country:      addr.country || null,
            postcode:     addr.postcode || null,

            // Zona para el sistema C5
            zone: buildZone(addr),
          };

          geoCache.set(cacheKey, { data: result, ts: Date.now() });
          resolve(result);
        } catch (e) {
          console.error("[Geolocation] Error parseando Nominatim:", e.message);
          resolve(fallbackZone(lat, lon));
        }
      });
    }).on("error", (e) => {
      console.error("[Geolocation] Error consultando Nominatim:", e.message);
      resolve(fallbackZone(lat, lon));
    });
  });
}

// Construir nombre de zona C5 a partir de la dirección
function buildZone(addr) {
  const parts = [];
  if (addr.neighbourhood || addr.suburb) parts.push(addr.neighbourhood || addr.suburb);
  if (addr.city || addr.town || addr.village) parts.push(addr.city || addr.town || addr.village);
  if (addr.state) parts.push(addr.state);
  return parts.length > 0 ? parts.join(", ") : "Zona Desconocida";
}

// Si Nominatim falla: zona por cuadrante geográfico (fallback)
function fallbackZone(lat, lon) {
  let ns = lat >= 0 ? "Norte" : "Sur";
  let ew = lon >= -100 ? "Oriente" : "Poniente";
  return {
    display_name: `Zona ${ns}-${ew} (aproximada)`,
    zone: `Zona ${ns}-${ew}`,
    street: null, neighborhood: null, city: null,
    state: null, country: null, postcode: null,
  };
}

// ── Procesador de cola Redis ───────────────────────────
async function processQueue() {
  console.log("[Geolocation] Escuchando cola queue:alerts...");

  while (true) {
    try {
      const result = await redis.brpop("queue:alerts", 5);
      if (!result) continue;

      const alert = JSON.parse(result[1]);
      const lat = parseFloat(alert.latitude);
      const lon = parseFloat(alert.longitude);

      console.log(`[Geolocation] Procesando: device=${alert.device_id} coords=(${lat}, ${lon})`);

      // Consultar OpenStreetMap / Nominatim
      const geoData = await reverseGeocode(lat, lon);

      const enriched = {
        ...alert,
        // Datos de geolocalización real
        zone:         geoData.zone,
        address:      geoData.display_name,
        street:       geoData.street,
        neighborhood: geoData.neighborhood,
        city:         geoData.city,
        state:        geoData.state,
        country:      geoData.country,
        postcode:     geoData.postcode,
        geo_processed:    true,
        geo_processed_at: new Date().toISOString(),
      };

      console.log(`[Geolocation] ✓ Zona: ${geoData.zone} | ${geoData.display_name?.substring(0, 60)}...`);

      // Pasar al siguiente microservicio
      await redisPub.lpush("queue:geo_processed", JSON.stringify(enriched));

      // Nominatim: máximo 1 req/segundo (política de uso justo)
      await new Promise(r => setTimeout(r, 1100));

    } catch (err) {
      console.error("[Geolocation] Error:", err.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// ── REST API ───────────────────────────────────────────
app.get("/health", (req, res) =>
  res.json({ status: "ok", service: "geolocation", provider: "OpenStreetMap/Nominatim" })
);

// Endpoint directo para consultar zona por coordenadas
app.post("/zone", async (req, res) => {
  const { latitude, longitude } = req.body;
  if (!latitude || !longitude)
    return res.status(400).json({ error: "Se requieren latitude y longitude" });

  const geoData = await reverseGeocode(parseFloat(latitude), parseFloat(longitude));
  res.json({ latitude, longitude, ...geoData });
});

// Endpoint GET para pruebas rápidas
app.get("/zone", async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon)
    return res.status(400).json({ error: "Se requieren ?lat=&lon=" });

  const geoData = await reverseGeocode(parseFloat(lat), parseFloat(lon));
  res.json({ lat, lon, ...geoData });
});

app.listen(PORT, () => {
  console.log(`[Geolocation] Servicio iniciado en puerto ${PORT}`);
  console.log(`[Geolocation] API: OpenStreetMap Nominatim (reverse geocoding)`);
  processQueue();
});
