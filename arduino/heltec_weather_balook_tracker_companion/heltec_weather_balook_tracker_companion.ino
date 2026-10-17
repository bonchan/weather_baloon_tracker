// Heltec Wireless Tracker (ESP32-S3 + UC6580 GNSS + 0.96" TFT) - USB GPS for the Sonde Tracker
// app (and any computer)
//
// Same as the ESP32-C3 companion: plug it in and it shows up as a USB serial port, no driver
// needed. Once a second it sends a $PSTK,POS line with the position (protocol in
// ../common/SondeTrackerLink.h). The module's own NMEA goes through too, so programs that
// read NMEA GPS ports (gpsd, u-center, OpenCPN...) can use it as well. The LoRa radio isn't
// used yet.
//
// Libraries (Library Manager): "TinyGPSPlus" (Mikal Hart),
//   "Adafruit ST7735 and ST7789 Library" (installs Adafruit GFX too).
// Board: "Heltec Wireless Tracker" with
//   Tools > USB Mode: Hardware CDC and JTAG   (TinyUSB's 64-byte buffer can't hold a line)
//   Tools > USB CDC On Boot: Enabled          (so Serial is the USB port)
// Both are the defaults for this board.
//
// Screen:
//   FIX / SEARCHING / NO DATA FROM GPS MODULE, satellites
//   latitude
//   longitude
//   altitude, speed
//   HDOP, local time
//   App connected / USB port open, no app / USB: waiting for the app
//
// Try it from a serial monitor: type $PSTK,HELLO and it answers with its $PSTK,ID line.

#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>
#include "../common/SondeTrackerGps.h"

#if defined(ARDUINO_USB_CDC_ON_BOOT) && !ARDUINO_USB_CDC_ON_BOOT
#error "Set Tools > USB CDC On Boot to Enabled, so Serial is the USB port"
#endif
#if defined(ARDUINO_USB_MODE) && !ARDUINO_USB_MODE
#error "Set Tools > USB Mode to Hardware CDC and JTAG"
#endif

// ---------------- Settings ----------------
#define DEVICE_NAME       "GPS-USB-Heltec"
#define FIRMWARE_VERSION  "1.0"
#define NMEA_PASSTHROUGH  true   // also send the module's raw NMEA to the computer
#define TZ_OFFSET_HOURS   -3     // local time on the screen (Argentina = -3)
#define LINK_TIMEOUT_MS   3000   // POS lines not fitting in the port this long = nobody reading

// ---------------- Pins ----------------
#define VEXT_CTRL   3    // powers GNSS + TFT (HIGH = on)
#define TFT_BL      21
#define TFT_CS      38
#define TFT_RST     39
#define TFT_DC      40
#define TFT_SCLK    41
#define TFT_MOSI    42
#define GPS_RX      33
#define GPS_TX      34
#define GPS_BAUD    115200

#define GREY        0x8410

Adafruit_ST7735 tft(&SPI, TFT_CS, TFT_DC, TFT_RST);
HardwareSerial GPSSerial(1);
stk::GpsReporter gps(NMEA_PASSTHROUGH);
stk::CommandReader commands;

bool appSeen = false;             // the app said HELLO since the port was last idle
unsigned long lastDelivered = 0;  // last POS that made it into the port

// ---------------- App commands ----------------
void sendId() {
  stk::sendId(Serial, stk::KIND_GPS, DEVICE_NAME, FIRMWARE_VERSION);
}

// Returns true when the screen needs a redraw
bool handleCommands() {
  bool changed = false;
  while (commands.poll(Serial)) {
    if (commands.is("HELLO")) {
      sendId();
      changed = !appSeen;
      appSeen = true;
    } else {
      stk::sendError(Serial, (String("Unknown command ") + commands.type()).c_str());
    }
  }
  return changed;
}

bool portRead() { return lastDelivered && millis() - lastDelivered < LINK_TIMEOUT_MS; }

// ---------------- Display ----------------
// Rows of the 160x80 screen: y and text size (size 1 = 6x8 px characters, 2 = 12x16)
struct Row { int16_t y; uint8_t size; };
const Row ROWS[] = {{0, 1}, {12, 2}, {30, 2}, {50, 1}, {60, 1}, {71, 1}};
const uint8_t ROW_COUNT = sizeof(ROWS) / sizeof(ROWS[0]);
char shown[ROW_COUNT][27];
uint16_t shownColor[ROW_COUNT];

// Padded to the screen width, so it covers the old text without clearing (no flicker).
// Rows that didn't change aren't redrawn.
void drawRow(uint8_t i, uint16_t color, const char *text) {
  char buf[27];
  snprintf(buf, sizeof(buf), "%-*s", 160 / (6 * ROWS[i].size), text);
  if (color == shownColor[i] && strcmp(buf, shown[i]) == 0) return;
  strcpy(shown[i], buf);
  shownColor[i] = color;
  tft.setTextSize(ROWS[i].size);
  tft.setTextColor(color, ST77XX_BLACK);
  tft.setCursor(0, ROWS[i].y);
  tft.print(buf);
}

void drawScreen() {
  const stk::Position &p = gps.last();
  bool fix = p.fix == stk::FIX_OK;
  char s[48];

  if (p.fix == stk::FIX_NO_GPS) {
    drawRow(0, ST77XX_RED, "NO DATA FROM GPS MODULE");
  } else {
    snprintf(s, sizeof(s), "%-14s%2d sats", fix ? "FIX" : "SEARCHING", p.sats < 0 ? 0 : p.sats);
    drawRow(0, fix ? ST77XX_GREEN : ST77XX_YELLOW, s);
  }

  snprintf(s, sizeof(s), "%.6f", p.lat);
  drawRow(1, fix ? ST77XX_WHITE : GREY, fix ? s : "--");
  snprintf(s, sizeof(s), "%.6f", p.lon);
  drawRow(2, fix ? ST77XX_WHITE : GREY, fix ? s : "--");

  char alt[12] = "--", spd[12] = "--";
  if (!isnan(p.altMsl)) snprintf(alt, sizeof(alt), "%.0f", p.altMsl);
  if (!isnan(p.speed)) snprintf(spd, sizeof(spd), "%.0f", p.speed * 3.6f);
  snprintf(s, sizeof(s), "Alt %s m   %s km/h", alt, spd);
  drawRow(3, ST77XX_WHITE, s);

  char hdop[8] = "--", hms[12] = "--:--:--";
  if (!isnan(p.hdop)) snprintf(hdop, sizeof(hdop), "%.1f", p.hdop);
  if (p.utc) {
    uint32_t t = p.utc + (int32_t)TZ_OFFSET_HOURS * 3600;
    snprintf(hms, sizeof(hms), "%02lu:%02lu:%02lu", (unsigned long)(t / 3600 % 24),
             (unsigned long)(t / 60 % 60), (unsigned long)(t % 60));
  }
  snprintf(s, sizeof(s), "HDOP %-8s%12s", hdop, hms);
  drawRow(4, ST77XX_WHITE, s);

  if (portRead() && appSeen) drawRow(5, ST77XX_GREEN, "App connected");
  else if (portRead()) drawRow(5, ST77XX_CYAN, "USB port open, no app");
  else drawRow(5, GREY, "USB: waiting for the app");
}

// ---------------- Setup / loop ----------------
void setup() {
  Serial.setTxBufferSize(2048);   // before begin(); room for NMEA bursts while the screen draws
  Serial.begin(stk::LINK_BAUD);

  pinMode(VEXT_CTRL, OUTPUT);
  digitalWrite(VEXT_CTRL, HIGH);
  delay(100);
  pinMode(TFT_BL, OUTPUT);
  digitalWrite(TFT_BL, HIGH);

  SPI.begin(TFT_SCLK, -1, TFT_MOSI, TFT_CS);
  tft.initR(INITR_MINI160x80_PLUGIN);
  tft.setRotation(1);
  tft.fillScreen(ST77XX_BLACK);
  tft.setTextWrap(false);
  drawRow(0, ST77XX_WHITE, "Starting...");

  GPSSerial.setRxBufferSize(4096);   // survive the pauses while the screen draws
  GPSSerial.begin(GPS_BAUD, SERIAL_8N1, GPS_RX, GPS_TX);

  sendId();
}

void loop() {
  bool redraw = false;
  if (gps.poll(GPSSerial, Serial)) {   // a POS went out (once a second)
    if (gps.delivered()) lastDelivered = millis();
    else if (!portRead()) appSeen = false;   // port went idle: the app has to say HELLO again
    redraw = true;
  }
  if (handleCommands()) redraw = true;
  if (redraw) drawScreen();
}
