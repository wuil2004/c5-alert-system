/*
 * C5 - Sistema de Alerta Ciudadana
 * ESP32 con botón físico de pánico + geolocalización por WiFi Scanning
 *
 * ── CÓMO FUNCIONA LA UBICACIÓN SIN GPS FÍSICO ──────────────────
 * El ESP32 escanea las redes WiFi cercanas (BSSID + señal).
 * Envía esa lista al servidor, que consulta la API de Mozilla
 * Location Services (MLS) para obtener coordenadas reales.
 * Funciona en cualquier lugar donde haya redes WiFi visibles.
 *
 * ── HARDWARE REQUERIDO ─────────────────────────────────────────
 *   - ESP32 (cualquier variante con WiFi)
 *   - Botón pulsador entre GPIO 0 y GND (o usar botón BOOT)
 *   - LED indicador en GPIO 2 (LED built-in del ESP32)
 *
 * ── LIBRERÍAS (instalar en Arduino IDE) ────────────────────────
 *   - PubSubClient   by Nick O'Leary
 *   - ArduinoJson    by Benoit Blanchon
 *   - HTTPClient     (incluida con el paquete ESP32)
 */

#include <WiFi.h>
#include <WiFiClient.h>
#include <HTTPClient.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// ══════════════════════════════════════════════════════
//  CONFIGURACIÓN — EDITA ESTOS VALORES ANTES DE FLASHEAR
// ══════════════════════════════════════════════════════

const char* WIFI_SSID       = "REDMI Note 15";        // Nombre de tu red WiFi
const char* WIFI_PASSWORD   = "Yos1234#";   // Contraseña

// IP de la máquina que corre Docker (tu computadora en la misma red)
// Ejecuta `ipconfig` (Windows) o `ifconfig` (Mac/Linux) para encontrarla
const char* MQTT_BROKER     = "10.113.201.11";      // <── CAMBIA ESTO
const int   MQTT_PORT       = 1883;
const char* MQTT_TOPIC      = "c5/alerts/panic";

// ID único de este dispositivo (cambia a ESP32-002 para el segundo)
const char* DEVICE_ID       = "ESP32-002";

// ══════════════════════════════════════════════════════
//  PINES
// ══════════════════════════════════════════════════════
const int BUTTON_PIN = 0;   // GPIO 0 = botón BOOT (ya integrado en el ESP32)
const int LED_PIN    = 2;   // GPIO 2 = LED built-in

// ══════════════════════════════════════════════════════
//  TIPOS DE EMERGENCIA
//  1 pulsación  → robo_con_violencia  (CRÍTICO)
//  2 pulsaciones → accidente_grave
//  3 pulsaciones → incendio
//  4 pulsaciones → violencia_familiar
//  5 pulsaciones → secuestro          (CRÍTICO)
// ══════════════════════════════════════════════════════
const char* EMERGENCY_TYPES[] = {
  "robo_con_violencia",
  "accidente_grave",
  "incendio",
  "violencia_familiar",
  "secuestro"
};
const int NUM_TYPES = 5;

// ══════════════════════════════════════════════════════
//  VARIABLES INTERNAS
// ══════════════════════════════════════════════════════
WiFiClient   espClient;
PubSubClient mqttClient(espClient);
HTTPClient   httpClient;

// Última ubicación obtenida (se cachea entre alertas)
float cachedLat = 19.95200417067262;
float cachedLon = -99.5371459247483;
bool  hasLocation = true;

// Control del botón
unsigned long lastButtonPress  = 0;
unsigned long pressWindowStart = 0;
bool buttonWasPressed          = false;
int  pressCount                = 0;

const unsigned long DEBOUNCE_MS   = 200;
const unsigned long PRESS_WINDOW  = 2000;   // 2s para contar pulsaciones múltiples


// ══════════════════════════════════════════════════════
//  CONEXIÓN WIFI
// ══════════════════════════════════════════════════════
void connectWiFi() {
  Serial.printf("\n[WiFi] Conectando a %s", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    digitalWrite(LED_PIN, !digitalRead(LED_PIN));
    attempts++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WiFi] ✓ Conectado! IP: %s\n", WiFi.localIP().toString().c_str());
    digitalWrite(LED_PIN, HIGH);
  } else {
    Serial.println("\n[WiFi] ✗ No se pudo conectar");
  }
}


// ══════════════════════════════════════════════════════
//  GEOLOCALIZACIÓN POR ESCANEO WIFI
//  Usa Mozilla Location Services (MLS) — gratuito, sin API key
//  Funciona en cualquier lugar del mundo con redes WiFi visibles
// ══════════════════════════════════════════════════════
bool getLocationByWiFiScan() {
  Serial.println("[GPS] Escaneando redes WiFi para determinar ubicación...");

  // Desconectar temporalmente para poder escanear (modo STA sigue activo)
  WiFi.disconnect();
  delay(200);

  int networksFound = WiFi.scanNetworks(false, true);  // incluye redes ocultas
  Serial.printf("[GPS] Redes encontradas: %d\n", networksFound);

  if (networksFound < 2) {
    Serial.println("[GPS] ⚠ Pocas redes, usando última ubicación conocida o fallback");
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    return hasLocation;
  }

  // Construir JSON para Mozilla Location Services
  // Documentación: https://ichnaea.readthedocs.io/en/latest/api/geolocate.html
  StaticJsonDocument<2048> doc;
  JsonArray wifiArray = doc.createNestedArray("wifiAccessPoints");

  int maxNetworks = min(networksFound, 10);  // MLS acepta hasta ~20, usamos 10
  for (int i = 0; i < maxNetworks; i++) {
    JsonObject ap = wifiArray.createNestedObject();
    ap["macAddress"]     = WiFi.BSSIDstr(i);
    ap["signalStrength"] = WiFi.RSSI(i);
    ap["channel"]        = WiFi.channel(i);
  }

  String requestBody;
  serializeJson(doc, requestBody);

  // Reconectar WiFi
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int wait = 0;
  while (WiFi.status() != WL_CONNECTED && wait < 20) {
    delay(300);
    wait++;
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[GPS] ✗ WiFi no disponible para consultar MLS");
    return false;
  }

  // Llamar a Mozilla Location Services
  httpClient.begin("https://location.services.mozilla.com/v1/geolocate?key=test");
  httpClient.addHeader("Content-Type", "application/json");

  int httpCode = httpClient.POST(requestBody);
  Serial.printf("[GPS] MLS response code: %d\n", httpCode);

  if (httpCode == 200) {
    String response = httpClient.getString();
    Serial.printf("[GPS] MLS respuesta: %s\n", response.c_str());

    StaticJsonDocument<256> resp;
    DeserializationError err = deserializeJson(resp, response);
    if (!err && resp["location"]["lat"] && resp["location"]["lng"]) {
      cachedLat   = resp["location"]["lat"].as<float>();
      cachedLon   = resp["location"]["lng"].as<float>();
      hasLocation = true;
      Serial.printf("[GPS] ✓ Ubicación: %.6f, %.6f (precisión: ~%dm)\n",
                    cachedLat, cachedLon,
                    resp["accuracy"].as<int>());
      httpClient.end();
      return true;
    }
  }

  httpClient.end();

  // Fallback: usar coordenadas del IP (menos preciso pero siempre funciona)
  Serial.println("[GPS] Intentando geolocalización por IP como respaldo...");
  httpClient.begin("http://ip-api.com/json/?fields=lat,lon,city,regionName");
  int ipCode = httpClient.GET();
  if (ipCode == 200) {
    String ipResp = httpClient.getString();
    StaticJsonDocument<256> ipDoc;
    deserializeJson(ipDoc, ipResp);
    cachedLat   = ipDoc["lat"].as<float>();
    cachedLon   = ipDoc["lon"].as<float>();
    hasLocation = true;
    Serial.printf("[GPS] ✓ Ubicación por IP: %.4f, %.4f (%s, %s)\n",
                  cachedLat, cachedLon,
                  ipDoc["city"].as<const char*>(),
                  ipDoc["regionName"].as<const char*>());
    httpClient.end();
    return true;
  }

  httpClient.end();
  return false;
}


// ══════════════════════════════════════════════════════
//  CONEXIÓN MQTT
// ══════════════════════════════════════════════════════
void connectMQTT() {
  int attempts = 0;
  while (!mqttClient.connected() && attempts < 5) {
    Serial.print("[MQTT] Conectando...");
    String clientId = String("ESP32-") + DEVICE_ID + "-" + String(millis());
    if (mqttClient.connect(clientId.c_str())) {
      Serial.println(" ✓ conectado!");
      mqttClient.publish("c5/devices/online", DEVICE_ID);
    } else {
      Serial.printf(" ✗ fallo rc=%d, reintentando...\n", mqttClient.state());
      delay(2000);
      attempts++;
    }
  }
}


// ══════════════════════════════════════════════════════
//  LED HELPERS
// ══════════════════════════════════════════════════════
void blinkLED(int times, int ms) {
  for (int i = 0; i < times; i++) {
    digitalWrite(LED_PIN, LOW);  delay(ms);
    digitalWrite(LED_PIN, HIGH); delay(ms);
  }
}

void ledPulse() {
  // Pulso suave para indicar "obteniendo ubicación"
  for (int i = 0; i < 3; i++) {
    digitalWrite(LED_PIN, LOW);  delay(400);
    digitalWrite(LED_PIN, HIGH); delay(400);
  }
}


// ══════════════════════════════════════════════════════
//  ENVIAR ALERTA VÍA MQTT
// ══════════════════════════════════════════════════════
void sendAlert(const char* emergencyType) {
  Serial.printf("\n[ALERT] ══ ENVIANDO ALERTA ══\n");
  Serial.printf("[ALERT] Tipo: %s\n", emergencyType);

  // 1. Obtener ubicación real
  ledPulse();  // parpadeo lento = obteniendo ubicación
  bool located = getLocationByWiFiScan();

  if (!located && !hasLocation) {
    Serial.println("[ALERT] ✗ Sin ubicación disponible, cancelando alerta");
    blinkLED(10, 80);  // parpadeo rápido = error
    return;
  }

  // 2. Construir payload JSON
  StaticJsonDocument<512> doc;
  doc["device_id"]      = DEVICE_ID;
  doc["latitude"]       = cachedLat;
  doc["longitude"]      = cachedLon;
  doc["emergency_type"] = emergencyType;
  doc["timestamp"]      = millis();
  doc["location_method"] = located ? "wifi_scan" : "cached";

  char buffer[512];
  serializeJson(doc, buffer);

  Serial.printf("[ALERT] Payload: %s\n", buffer);

  // 3. Publicar en MQTT
  if (!mqttClient.connected()) connectMQTT();

  if (mqttClient.publish(MQTT_TOPIC, buffer, true)) {
    Serial.println("[ALERT] ✓ Alerta enviada exitosamente!");
    blinkLED(3, 150);   // 3 parpadeos rápidos = éxito
  } else {
    Serial.println("[ALERT] ✗ Error enviando alerta");
    blinkLED(10, 60);   // parpadeo muy rápido = error
  }
}


// ══════════════════════════════════════════════════════
//  SETUP
// ══════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  Serial.println("\n");
  Serial.println("╔═══════════════════════════════════════╗");
  Serial.println("║   C5 - Sistema de Alerta Ciudadana    ║");
  Serial.println("║   ESP32 Botón de Pánico               ║");
  Serial.printf( "║   Dispositivo: %-22s ║\n", DEVICE_ID);
  Serial.println("╚═══════════════════════════════════════╝");

  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  connectWiFi();

  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setKeepAlive(60);
  connectMQTT();

  // Obtener ubicación inicial al arrancar
  Serial.println("[Setup] Obteniendo ubicación inicial...");
  getLocationByWiFiScan();

  Serial.println("\n[Setup] ✓ Sistema listo");
  Serial.println("[Setup] Presiona el botón para enviar alerta:");
  Serial.println("  1 pulsación  → robo_con_violencia (CRÍTICO)");
  Serial.println("  2 pulsaciones → accidente_grave");
  Serial.println("  3 pulsaciones → incendio");
  Serial.println("  4 pulsaciones → violencia_familiar");
  Serial.println("  5 pulsaciones → secuestro (CRÍTICO)");
  Serial.println("  (todas dentro de 2 segundos)\n");

  blinkLED(2, 300);
  digitalWrite(LED_PIN, HIGH);  // LED encendido = listo
}


// ══════════════════════════════════════════════════════
//  LOOP
// ══════════════════════════════════════════════════════
void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWiFi();
  if (!mqttClient.connected())        connectMQTT();
  mqttClient.loop();

  // ── Lectura del botón con anti-rebote ───────────────
  bool buttonPressed = (digitalRead(BUTTON_PIN) == LOW);

  if (buttonPressed && !buttonWasPressed) {
    unsigned long now = millis();
    if (now - lastButtonPress > DEBOUNCE_MS) {
      lastButtonPress = now;
      buttonWasPressed = true;
      if (pressCount == 0) pressWindowStart = now;
      pressCount++;
      Serial.printf("[Button] Pulsación #%d\n", pressCount);
      digitalWrite(LED_PIN, LOW);
    }
  }

  if (!buttonPressed && buttonWasPressed) {
    buttonWasPressed = false;
    digitalWrite(LED_PIN, HIGH);
  }

  // ── Procesar cuando termina la ventana de 2s ────────
  if (pressCount > 0 && (millis() - pressWindowStart) > PRESS_WINDOW) {
    int typeIndex = (pressCount - 1) % NUM_TYPES;
    Serial.printf("[Button] %d pulsación(es) → %s\n",
                  pressCount, EMERGENCY_TYPES[typeIndex]);
    sendAlert(EMERGENCY_TYPES[typeIndex]);
    pressCount = 0;
  }

  delay(50);
}
