# ESP32 — Botón de Pánico C5

## ¿Cómo obtiene la ubicación sin GPS físico?

El ESP32 **escanea las redes WiFi visibles** (BSSID + señal) y consulta
**Mozilla Location Services (MLS)** para convertir esas redes en coordenadas
GPS reales. Funciona en cualquier lugar del mundo donde haya redes WiFi cercanas.

Si MLS falla, usa **ip-api.com** como respaldo (geolocalización por IP).

```
ESP32 escanea WiFis cercanas
        │
        ▼
Mozilla Location Services (gratuito, sin API key)
        │
        ▼
Coordenadas lat/lon reales
        │
        ▼
Publica alerta MQTT → Sistema C5
```

## Configuración antes de flashear

Edita estas 4 líneas en `panic_button.ino`:

```cpp
const char* WIFI_SSID     = "TU_RED_WIFI";       // Tu red WiFi
const char* WIFI_PASSWORD = "TU_PASSWORD_WIFI";   // Tu contraseña
const char* MQTT_BROKER   = "192.168.1.100";      // IP de tu PC con Docker
const char* DEVICE_ID     = "ESP32-001";          // ESP32-002 para el segundo
```

**¿Cómo saber tu IP?**
- Windows: abre CMD → `ipconfig` → busca "Dirección IPv4"
- Mac/Linux: `ifconfig | grep inet`

## Instalar librerías en Arduino IDE

1. `Sketch` → `Include Library` → `Manage Libraries`
2. Buscar e instalar:
   - **PubSubClient** by Nick O'Leary
   - **ArduinoJson** by Benoit Blanchon
   - HTTPClient ya viene incluida con el paquete ESP32

## Instalar soporte ESP32

`File` → `Preferences` → URLs adicionales:
```
https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
```
Luego: `Tools` → `Board Manager` → buscar "esp32" → instalar

Seleccionar placa: **ESP32 Dev Module**

## Conexión del botón (si no usas el botón BOOT)

```
ESP32 GPIO 0  ──────┤ Botón ├────── GND
```
El botón BOOT ya está integrado en la mayoría de ESP32 DevKit (GPIO 0).

## Uso — tipos de alerta

Presiona el botón varias veces **dentro de 2 segundos**:

| Pulsaciones | Tipo de emergencia | Prioridad |
|:-----------:|---|:---------:|
| 1 | `robo_con_violencia` | 🔴 CRÍTICO |
| 2 | `accidente_grave` | 🟠 ALTO |
| 3 | `incendio` | 🟠 ALTO |
| 4 | `violencia_familiar` | 🟡 MEDIO |
| 5 | `secuestro` | 🔴 CRÍTICO |

## Indicadores LED

| Patrón | Significado |
|---|---|
| LED fijo encendido | Sistema listo |
| Parpadeo lento (3x) | Obteniendo ubicación GPS |
| 3 parpadeos rápidos | ✅ Alerta enviada |
| 10 parpadeos muy rápidos | ❌ Error al enviar |

## Monitor Serial (115200 baud)

```
╔═══════════════════════════════════════╗
║   C5 - Sistema de Alerta Ciudadana    ║
║   ESP32 Botón de Pánico               ║
║   Dispositivo: ESP32-001              ║
╚═══════════════════════════════════════╝
[WiFi] Conectando a MiRed... conectado! IP: 192.168.1.45
[GPS] Escaneando redes WiFi para determinar ubicación...
[GPS] Redes encontradas: 8
[GPS] ✓ Ubicación: 20.052700, -99.346700 (precisión: ~35m)
[Setup] ✓ Sistema listo

[Button] Pulsación #1
[ALERT] ══ ENVIANDO ALERTA ══
[ALERT] Tipo: robo_con_violencia
[GPS] Escaneando redes WiFi...
[GPS] ✓ Ubicación: 20.052700, -99.346700
[ALERT] ✓ Alerta enviada exitosamente!
```
