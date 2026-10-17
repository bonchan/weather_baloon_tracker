// ESP32-C3 Super Mini + NEO-6M - USB GPS for the Sonde Tracker app (and any computer)
//
// Plug it in and it shows up as a USB serial port, no driver needed. Once a second it sends
// a $PSTK,POS line with the position (protocol in ../common/SondeTrackerLink.h). The module's
// own NMEA goes through too, so programs that read NMEA GPS ports (gpsd, u-center,
// OpenCPN...) can use it as well.
//
// Library (Library Manager): "TinyGPSPlus" (Mikal Hart).
// Board: "Nologo ESP32C3 Super Mini", or "ESP32C3 Dev Module" with
//        Tools > USB CDC On Boot: Enabled (so Serial is the USB port).
//
// Wiring (C3 -> NEO-6M): GND-GND, 3V3-VCC, GPIO3-RX, GPIO4-TX
//
// Blue LED (GPIO8):
//   fast blink for ~1.5 s     -> power-on
//   double blink every 2 s    -> no data from the GPS module (check the wiring)
//   slow blink                -> searching for satellites
//   short blink every second  -> fix
//
// Try it from a serial monitor: type $PSTK,HELLO and it answers with its $PSTK,ID line.

#include "../common/SondeTrackerGps.h"

#if defined(CONFIG_IDF_TARGET_ESP32C3) && defined(ARDUINO_USB_CDC_ON_BOOT) && !ARDUINO_USB_CDC_ON_BOOT
#error "Set Tools > USB CDC On Boot to Enabled, so Serial is the USB port"
#endif

// ---------------- Settings ----------------
#define DEVICE_NAME       "GPS-USB-C3"
#define FIRMWARE_VERSION  "1.0"
#define NMEA_PASSTHROUGH  true   // also send the module's raw NMEA to the computer

// ---------------- Pins ----------------
#define GPS_RX_PIN     4    // ESP receives here  <- NEO-6M TX
#define GPS_TX_PIN     3    // ESP sends here     -> NEO-6M RX
#define GPS_BAUD       9600 // NEO-6M default
#define LED_PIN        8    // blue LED
#define LED_ACTIVE_LOW 1    // Super Mini LED is lit when the pin is LOW

HardwareSerial GPSSerial(1);
stk::GpsReporter gps(NMEA_PASSTHROUGH);
stk::CommandReader commands;

unsigned long bootFlashUntil = 0;

// ---------------- App commands ----------------
void sendId() {
  stk::sendId(Serial, stk::KIND_GPS, DEVICE_NAME, FIRMWARE_VERSION);
}

void handleCommands() {
  while (commands.poll(Serial)) {
    if (commands.is("HELLO")) sendId();
    else stk::sendError(Serial, (String("Unknown command ") + commands.type()).c_str());
  }
}

// ---------------- LED ----------------
void updateLed() {
  unsigned long now = millis();
  bool on;
  if (now < bootFlashUntil) {
    on = (now / 60) % 2 == 0;                   // ~8 Hz
  } else {
    switch (gps.fix()) {
      case stk::FIX_NO_GPS: {
        unsigned long t = now % 2000;
        on = t < 100 || (t >= 250 && t < 350);  // double blink
        break;
      }
      case stk::FIX_SEARCHING:
        on = now % 1000 < 500;
        break;
      default:
        on = now % 1000 < 80;
        break;
    }
  }
  digitalWrite(LED_PIN, (on ^ LED_ACTIVE_LOW) ? HIGH : LOW);
}

// ---------------- Setup / loop ----------------
void setup() {
  Serial.setTxBufferSize(1024);   // before begin(); room for NMEA bursts
  Serial.begin(stk::LINK_BAUD);

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LED_ACTIVE_LOW ? HIGH : LOW);   // off

  GPSSerial.setRxBufferSize(1024);
  GPSSerial.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);

  bootFlashUntil = millis() + 1500;   // "I'm alive"
  sendId();
}

void loop() {
  gps.poll(GPSSerial, Serial);
  handleCommands();
  updateLed();
}
