// Heltec Wireless Tracker (ESP32-S3 + UC6580 GNSS + SX1262 LoRa + 0.96" TFT) - the base station
// of the Sonde Tracker search team, plugged into the computer running the web app.
//
// Plug it in and it shows up as a USB serial port, no driver needed (protocol in
// ../common/SondeTrackerLink.h):
//   - USB GPS: once a second a $PSTK,POS with its position, plus the module's raw NMEA, so
//     NMEA programs (gpsd, u-center, OpenCPN...) can use it too.
//   - LoRa base: it owns the team network (a random 4-digit net id kept in flash). Every
//     BASE_POS_MS it broadcasts its own position as "BASE". What it hears on its network goes
//     to the web app as $PSTK,HEARD; satellites asking to join show up as $PSTK,JOINREQ and
//     the web app answers with ACCEPT / REJECT. The web app sends the balloon and relays the
//     team with TX.
//
// Libraries (Library Manager): "TinyGPSPlus" (Mikal Hart), "RadioLib" (Jan Gromes),
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
//   App / USB status, LoRa network id, packets heard
//
// Try it from a serial monitor: type $PSTK,HELLO and it answers with its $PSTK,ID line.

#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>
#include "../common/SondeTrackerGps.h"
#include "../common/SondeTrackerLora.h"

#if defined(ARDUINO_USB_CDC_ON_BOOT) && !ARDUINO_USB_CDC_ON_BOOT
#error "Set Tools > USB CDC On Boot to Enabled, so Serial is the USB port"
#endif
#if defined(ARDUINO_USB_MODE) && !ARDUINO_USB_MODE
#error "Set Tools > USB Mode to Hardware CDC and JTAG"
#endif

// ---------------- Settings ----------------
#define DEVICE_NAME       "Base-Heltec-Tracker"
#define FIRMWARE_VERSION  "2.0"
#define NMEA_PASSTHROUGH  true   // also send the module's raw NMEA to the computer
#define TZ_OFFSET_HOURS   -3     // local time on the screen (Argentina = -3)
#define LINK_TIMEOUT_MS   3000   // POS lines not fitting in the port this long = nobody reading
#define LORA_POWER_DBM    22     // SX1262 output; the Wireless Tracker has no external PA
#define BASE_POS_MS       10000  // how often the base broadcasts its own position

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
stk::LoraLink lora(stk::HELTEC_LORA_PINS);
stk::NetStore netStore;

char net[stk::NET_LEN + 1];
char device[stk::DEVICE_LEN + 1];
bool appSeen = false;             // the app said HELLO since the port was last idle
unsigned long lastDelivered = 0;  // last POS that made it into the port
unsigned long lastBasePos = 0;
uint32_t heardCount = 0;

// ---------------- App commands ----------------
void sendId() {
  stk::sendId(Serial, stk::KIND_BASE, DEVICE_NAME, FIRMWARE_VERSION, net, device);
}

void sendTo(const char *type, const char *args) {
  char body[stk::MAX_LINE];
  snprintf(body, sizeof(body), "PSTK,%s,%s", type, args);
  if (!lora.sendBody(net, body)) stk::sendError(Serial, "LoRa transmit failed");
}

// Returns true when the screen needs a redraw
bool handleCommands() {
  bool changed = false;
  while (commands.poll(Serial)) {
    const char *args = commands.args();
    if (commands.is("HELLO")) {
      sendId();
      changed = !appSeen;
      appSeen = true;
    } else if (commands.is("TX")) {
      // args is a whole inner sentence, e.g. "PSTK,SONDE,..."
      if (strncmp(args, "PSTK,", 5) != 0 || !lora.sendBody(net, args)) stk::sendError(Serial, "TX failed");
    } else if (commands.is("ACCEPT")) {
      char reply[stk::DEVICE_LEN + stk::NET_LEN + 2];
      snprintf(reply, sizeof(reply), "%.6s,%s", args, net);
      sendTo("ACCEPT", reply);
    } else if (commands.is("REJECT")) {
      sendTo("REJECT", args);
    } else if (commands.is("NEWNET")) {
      stk::NetStore::random(net);
      netStore.save(net);
      sendId();
      changed = true;
    } else {
      stk::sendError(Serial, (String("Unknown command ") + commands.type()).c_str());
    }
  }
  return changed;
}

// ---------------- LoRa ----------------
// Returns true when the screen needs a redraw
bool handleLora() {
  bool changed = false;
  while (lora.poll()) {
    if (strcmp(lora.net(), net) == 0) {
      stk::sendHeard(Serial, lora.rssi(), lora.snr(), lora.body());
      heardCount++;
      changed = true;
    } else if (lora.is("JOIN")) {
      // "device,callsign" from a satellite that isn't on our network yet
      stk::Sentence("JOINREQ").field(lora.rssi(), 0).field(lora.snr(), 1).field(lora.args()).send(Serial);
      changed = true;
    }
  }
  return changed;
}

void broadcastBasePosition() {
  const stk::Position &last = gps.last();
  if (last.fix != stk::FIX_OK || millis() - lastBasePos < BASE_POS_MS) return;
  lastBasePos = millis();
  stk::Position p = last;
  p.src = stk::SRC_BASE;
  stk::LineBuffer line;
  if (stk::sendPosition(line, p)) lora.sendLine(net, line.c_str());
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

  const char *app = portRead() && appSeen ? "App" : portRead() ? "USB" : "---";
  uint16_t color = portRead() && appSeen ? ST77XX_GREEN : portRead() ? ST77XX_CYAN : GREY;
  if (!lora.ok()) {
    snprintf(s, sizeof(s), "%s  LoRa ERROR %d", app, lora.error());
    color = ST77XX_RED;
  } else {
    snprintf(s, sizeof(s), "%s  NET %s  rx %lu", app, net, (unsigned long)heardCount);
  }
  drawRow(5, color, s);
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

  GPSSerial.setRxBufferSize(4096);   // survive the pauses while the screen draws or LoRa sends
  GPSSerial.begin(GPS_BAUD, SERIAL_8N1, GPS_RX, GPS_TX);

  stk::deviceId(device);
  netStore.load(net);
  if (strcmp(net, stk::NO_NET) == 0) {   // first boot: start our own network
    stk::NetStore::random(net);
    netStore.save(net);
  }
  if (!lora.begin(LORA_POWER_DBM)) {
    char msg[40];
    snprintf(msg, sizeof(msg), "LoRa init failed: %d", lora.error());
    stk::sendLog(Serial, msg);
  }

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
  if (handleLora()) redraw = true;
  broadcastBasePosition();
  if (redraw) drawScreen();
}
