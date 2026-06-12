#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// ══════════════════════════════════════════════════════
//  CONFIGURACIÓN Y PINES
// ══════════════════════════════════════════════════════
const char* WIFI_SSID       = "Familia Matias";
const char* WIFI_PASSWORD   = "2004Sistem;
const char* MQTT_BROKER     = "10.113.201.11";
const int   MQTT_PORT       = 1883;
const char* MQTT_TOPIC      = "c5/alerts/panic";
const char* DEVICE_ID       = "ESP32-001";

// Ubicación fija
const float FIXED_LAT       = 19.7136; 
const float FIXED_LON       = -99.7613;

// Nuevos Pines
const int BUTTON_PIN = 14; 
const int RED_PIN    = 25;
const int GREEN_PIN  = 26;
const int BLUE_PIN   = 27;

const char* EMERGENCY_TYPES[] = {"robo_con_violencia", "accidente_grave", "incendio", "violencia_familiar", "secuestro"};
const int NUM_TYPES = 5;

// Control
WiFiClient   espClient;
PubSubClient mqttClient(espClient);
unsigned long lastButtonPress = 0, pressWindowStart = 0;
bool buttonWasPressed = false;
int  pressCount = 0;
const unsigned long DEBOUNCE_MS = 200, PRESS_WINDOW = 2000;

// Funciones LED ajustadas para Ánodo Común
void setColor(bool r, bool g, bool b) {
  // Ahora LOW enciende y HIGH apaga
  digitalWrite(RED_PIN, !r);   
  digitalWrite(GREEN_PIN, !g);
  digitalWrite(BLUE_PIN, !b);
}

void setup() {
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(RED_PIN, OUTPUT); pinMode(GREEN_PIN, OUTPUT); pinMode(BLUE_PIN, OUTPUT);
  
  connectWiFi();
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  
  setColor(0, 1, 0); // Verde: Sistema Listo
}

void sendAlert(const char* emergencyType) {
  setColor(1, 0, 0); // Rojo: Enviando alerta
  
  StaticJsonDocument<512> doc;
  doc["device_id"] = DEVICE_ID;
  doc["latitude"] = FIXED_LAT;
  doc["longitude"] = FIXED_LON;
  doc["emergency_type"] = emergencyType;
  doc["location_method"] = "fixed_post";
  
  char buffer[512];
  serializeJson(doc, buffer);
  
  if (!mqttClient.connected()) connectMQTT();
  mqttClient.publish(MQTT_TOPIC, buffer, true);
  
  delay(1000); 
  setColor(0, 1, 0); // Regresa a Verde
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWiFi();
  if (!mqttClient.connected()) connectMQTT();
  mqttClient.loop();

  bool buttonPressed = (digitalRead(BUTTON_PIN) == LOW);
  if (buttonPressed && !buttonWasPressed) {
    if (millis() - lastButtonPress > DEBOUNCE_MS) {
      lastButtonPress = millis();
      buttonWasPressed = true;
      if (pressCount == 0) {
        pressWindowStart = millis();
        setColor(0, 0, 1); // Azul: Registrando pulsaciones
      }
      pressCount++;
    }
  }
  if (!buttonPressed && buttonWasPressed) buttonWasPressed = false;

  if (pressCount > 0 && (millis() - pressWindowStart) > PRESS_WINDOW) {
    sendAlert(EMERGENCY_TYPES[(pressCount - 1) % NUM_TYPES]);
    pressCount = 0;
  }
}

void connectWiFi() {
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) delay(500);
}

void connectMQTT() {
  if (mqttClient.connect(DEVICE_ID)) mqttClient.publish("c5/devices/online", DEVICE_ID);
}