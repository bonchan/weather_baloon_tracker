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

#include <TinyGPSPlus.h>
#include "../common/SondeTrackerLink.h"

#if defined(CONFIG_IDF_TARGET_ESP32C3) && defined(ARDUINO_USB_CDC_ON_BOOT) && !ARDUINO_USB_CDC_ON_BOOT
#error "Set Tools > USB CDC On Boot to Enabled, so Serial is the USB port"
#endif

// ---------------- Settings ----------------
#define DEVICE_NAME       "GPS-USB-C3"
#define FIRMWARE_VERSION  "1.0"
#define NMEA_PASSTHROUGH  1      // also send the module's raw NMEA to the computer
#define GPS_SILENT_MS     3000   // no valid sentence for this long = no GPS
#define FIX_MAX_AGE_MS    3000   // older position = fix lost
#define POS_FALLBACK_MS   1500   // POS at least this often, even when the module is silent

// ---------------- Pins ----------------
#define GPS_RX_PIN     4    // ESP receives here  <- NEO-6M TX
#define GPS_TX_PIN     3    // ESP sends here     -> NEO-6M RX
#define GPS_BAUD       9600 // NEO-6M default
#define LED_PIN        8    // blue LED
#define LED_ACTIVE_LOW 1    // Super Mini LED is lit when the pin is LOW

TinyGPSPlus gps;
HardwareSerial GPSSerial(1);
TinyGPSCustom geoidSepGP(gps, "GPGGA", 11);   // TinyGPSPlus doesn't parse it
TinyGPSCustom geoidSepGN(gps, "GNGGA", 11);   // multi-GNSS modules (NEO-M8N...)
stk::CommandReader commands;
stk::NmeaForwarder nmea;

bool gpsTalking = false;
unsigned long lastGpsSentence = 0, lastPosSent = 0, bootFlashUntil = 0;

// ---------------- GPS ----------------
stk::Fix fixState() {
  if (!gpsTalking || millis() - lastGpsSentence > GPS_SILENT_MS) return stk::FIX_NO_GPS;
  if (gps.location.isValid() && gps.location.age() < FIX_MAX_AGE_MS) return stk::FIX_OK;
  return stk::FIX_SEARCHING;
}

bool gpsTimeValid() {
  return gps.date.isValid() && gps.time.isValid() && gps.date.year() >= 2020;
}

bool fresh(TinyGPSDecimal &v) { return v.isValid() && v.age() < FIX_MAX_AGE_MS; }

void sendPosition() {
  stk::Position p;
  p.fix = fixState();
  int sats = gps.satellites.isValid() ? gps.satellites.value() : -1;   // reading clears isUpdated()
  if (p.fix != stk::FIX_NO_GPS) {
    p.sats = sats;
    if (gps.hdop.isValid()) p.hdop = gps.hdop.hdop();
    if (gpsTimeValid())
      p.utc = stk::unixTime(gps.date.year(), gps.date.month(), gps.date.day(),
                            gps.time.hour(), gps.time.minute(), gps.time.second());
  }
  if (p.fix == stk::FIX_OK) {
    p.lat = gps.location.lat();
    p.lon = gps.location.lng();
    if (fresh(gps.altitude)) p.altMsl = gps.altitude.meters();
    if (fresh(gps.speed)) p.speed = gps.speed.mps();
    if (fresh(gps.course)) p.course = gps.course.deg();
    TinyGPSCustom &sep = geoidSepGN.age() < geoidSepGP.age() ? geoidSepGN : geoidSepGP;
    if (sep.isValid() && sep.age() < FIX_MAX_AGE_MS && sep.value()[0]) p.geoidSep = atof(sep.value());
  }
  stk::sendPosition(Serial, p);
  lastPosSent = millis();
}

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
    switch (fixState()) {
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
  Serial.begin(stk::LINK_BAUD);

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LED_ACTIVE_LOW ? HIGH : LOW);   // off

  GPSSerial.setRxBufferSize(1024);
  GPSSerial.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);

  bootFlashUntil = millis() + 1500;   // "I'm alive"
  sendId();
}

void loop() {
  while (GPSSerial.available()) {
    char c = GPSSerial.read();
#if NMEA_PASSTHROUGH
    nmea.feed(c, Serial);
#endif
    if (gps.encode(c)) {   // a sentence with a good checksum
      gpsTalking = true;
      lastGpsSentence = millis();
    }
  }

  // Each GGA (once per fix, with sats/hdop/altitude) sets satellites.isUpdated()
  if (gps.satellites.isUpdated() || millis() - lastPosSent >= POS_FALLBACK_MS) sendPosition();

  handleCommands();
  updateLed();
}
