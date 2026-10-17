// Heltec WiFi LoRa 32 V3 / V4 - a satellite node of the Sonde Tracker search team.
//
// It pairs over Bluetooth with the phone app and puts it on the team's LoRa network
// (protocol in ../common/SondeTrackerLink.h, radio settings in ../common/SondeTrackerLora.h):
//   - the phone sends $PSTK commands: JOIN <callsign> asks the base station to let us in;
//     once the base accepts, TX <sentence> sends the phone's position to the team;
//   - what the node hears on its network goes to the phone as $PSTK,HEARD (the base station,
//     the balloon and the other satellites);
//   - the network id is kept in flash, so after a reboot the node is still on the team.
// The same lines go to the USB serial port, so a serial monitor shows what happens and
// accepts the same commands (type $PSTK,HELLO).
//
// Libraries (Library Manager): "RadioLib" (Jan Gromes), "NimBLE-Arduino" (h2zero, 1.4.x),
//   "Adafruit SSD1306" (installs Adafruit GFX too).
// Board: "Heltec WiFi LoRa 32(V3)" (also for the V4), and pick the board below.
//
// Screen (wakes for a while on every event or with the PRG button):
//   callsign / device id
//   network: NO NETWORK / JOIN SENT / NET 3F2A
//   Bluetooth: phone connected or waiting
//   packets heard, last RSSI

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <NimBLEDevice.h>
#include "../common/SondeTrackerLora.h"

// ---------------- Board: uncomment ONLY ONE ----------------
#define HELTEC_V3_BOARD
// #define HELTEC_V4_BOARD

// ---------------- Settings ----------------
#define FIRMWARE_VERSION  "2.0"
#define SCREEN_ON_MS      15000

#if defined(HELTEC_V3_BOARD)
  #define LORA_POWER_DBM  22   // SX1262 maximum
#elif defined(HELTEC_V4_BOARD)
  // The V4's GC1109 PA adds its own gain on top. Pins as in Meshtastic's heltec_v4 variant:
  // check them against Heltec's V4 schematic before trusting the output power.
  #define LORA_POWER_DBM  10
  #define PA_POWER_PIN    7    // powers the PA
  #define PA_ENABLE_PIN   2    // PA chip enable
  #define PA_TX_PIN       46   // high while transmitting
#else
  #error "Pick HELTEC_V3_BOARD or HELTEC_V4_BOARD above"
#endif

// ---------------- Pins ----------------
#define OLED_SDA     17
#define OLED_SCL     18
#define OLED_RST     21
#define VEXT_CTRL    36   // powers the OLED (LOW = on)
#define BUTTON_PIN   0    // PRG button

// Nordic UART service, which the phone app looks for.
#define UART_SERVICE  "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define UART_RX       "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"   // the phone writes here
#define UART_TX       "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"   // we notify here

Adafruit_SSD1306 display(128, 64, &Wire, OLED_RST);
stk::LoraLink lora(stk::HELTEC_LORA_PINS);
stk::NetStore netStore;
stk::CommandReader serialCommands;
stk::CommandReader bleCommands;
Preferences prefs;

char net[stk::NET_LEN + 1];
char device[stk::DEVICE_LEN + 1];
char callsign[9] = "";
bool joinPending = false;
uint32_t heardCount = 0;
float lastRssi = NAN;
unsigned long screenOffAt = 0;
bool screenOn = false;

NimBLECharacteristic *txChar = nullptr;
volatile bool phoneConnected = false;
volatile uint16_t phoneConn = 0;
// Bluetooth writes arrive on the BLE task; loop() turns them into commands.
QueueHandle_t bleRx;

// ---------------- Lines to the phone and the serial port ----------------
// A whole sentence ("$...*hh") goes to the serial port and, chunked to the link's MTU, to the phone.
void emit(const char *line) {
  Serial.print(line);
  Serial.print("\r\n");
  if (!phoneConnected || !txChar) return;
  uint16_t mtu = NimBLEDevice::getServer()->getPeerMTU(phoneConn);
  size_t chunk = mtu > 23 ? mtu - 3 : 20;
  String text = String(line) + "\r\n";
  for (size_t i = 0; i < text.length(); i += chunk) {
    String part = text.substring(i, i + chunk);
    txChar->setValue((const uint8_t *)part.c_str(), part.length());
    txChar->notify();
  }
}

void emit(stk::Sentence &s) {
  stk::LineBuffer line;
  if (s.send(line)) emit(line.c_str());
}

void sendId() {
  stk::Sentence s("ID");
  s.field(stk::PROTOCOL_VERSION).field(stk::KIND_LORA).field(callsign[0] ? callsign : "SAT")
      .field(FIRMWARE_VERSION).field(net).field(device);
  emit(s);
}

void logLine(const char *text) {
  stk::Sentence s("LOG");
  s.field(text);
  emit(s);
}

void errorLine(const char *text) {
  stk::Sentence s("ERR");
  s.field(text);
  emit(s);
}

bool onNetwork() { return strcmp(net, stk::NO_NET) != 0; }

// ---------------- Bluetooth ----------------
class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *server, ble_gap_conn_desc *desc) override {
    phoneConn = desc->conn_handle;
    phoneConnected = true;
  }
  void onDisconnect(NimBLEServer *server) override {
    phoneConnected = false;
    NimBLEDevice::startAdvertising();
  }
};

class RxCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *c) override {
    std::string value = c->getValue();
    for (char ch : value) xQueueSend(bleRx, &ch, 0);
  }
};

void startBluetooth() {
  char name[24];
  snprintf(name, sizeof(name), "SondeTracker-%s", device);
  NimBLEDevice::init(name);
  NimBLEDevice::setMTU(185);   // a $PSTK line in one notification on phones that allow it
  NimBLEServer *server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  NimBLEService *service = server->createService(UART_SERVICE);
  txChar = service->createCharacteristic(UART_TX, NIMBLE_PROPERTY::NOTIFY);
  NimBLECharacteristic *rx = service->createCharacteristic(UART_RX, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  rx->setCallbacks(new RxCallbacks());
  service->start();
  NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(UART_SERVICE);
  adv->setScanResponse(true);   // room for the name next to the 128-bit service UUID
  adv->start();
}

// ---------------- Commands (from the phone or the serial port) ----------------
void handle(stk::CommandReader &cmd) {
  const char *args = cmd.args();
  if (cmd.is("HELLO")) {
    sendId();
  } else if (cmd.is("JOIN")) {
    strlcpy(callsign, args, sizeof(callsign));
    prefs.putString("callsign", callsign);
    char body[48];
    snprintf(body, sizeof(body), "PSTK,JOIN,%s,%s", device, callsign);
    if (lora.sendBody(stk::NO_NET, body)) {
      joinPending = true;
      logLine("Join request sent");
    } else {
      errorLine("LoRa transmit failed");
    }
  } else if (cmd.is("LEAVE")) {
    strlcpy(net, stk::NO_NET, sizeof(net));
    netStore.save(net);
    joinPending = false;
    sendId();
  } else if (cmd.is("TX")) {
    if (!onNetwork()) errorLine("Not on a network: JOIN first");
    else if (strncmp(args, "PSTK,", 5) != 0 || !lora.sendBody(net, args)) errorLine("TX failed");
  } else {
    errorLine((String("Unknown command ") + cmd.type()).c_str());
  }
  wakeScreen();
}

// ---------------- LoRa ----------------
// "device,..." addressed to this node?
bool forMe(const char *args) { return strncmp(args, device, stk::DEVICE_LEN) == 0 && args[stk::DEVICE_LEN] == ','; }
bool forMeExact(const char *args) { return strcmp(args, device) == 0; }

void handleLora() {
  while (lora.poll()) {
    lastRssi = lora.rssi();
    if (lora.is("ACCEPT") && forMe(lora.args())) {
      const char *given = lora.args() + stk::DEVICE_LEN + 1;
      if (!stk::validNet(given)) continue;
      strlcpy(net, given, sizeof(net));
      netStore.save(net);
      joinPending = false;
      stk::Sentence s("BOUND");
      s.field(net);
      emit(s);
      sendId();
    } else if (lora.is("REJECT") && forMeExact(lora.args())) {
      joinPending = false;
      stk::Sentence s("REJECTED");
      emit(s);
    } else if (lora.is("KICK") && onNetwork() && strcmp(lora.net(), net) == 0 &&
               (forMeExact(lora.args()) || strcmp(lora.args(), "*") == 0)) {
      strlcpy(net, stk::NO_NET, sizeof(net));
      netStore.save(net);
      joinPending = false;
      stk::Sentence s("KICKED");
      emit(s);
      sendId();
    } else if (onNetwork() && strcmp(lora.net(), net) == 0) {
      heardCount++;
      stk::Sentence s("HEARD");
      s.field(lora.rssi(), 0).field(lora.snr(), 1).field(lora.body());
      emit(s);
    }
    wakeScreen();
  }
}

// ---------------- Screen ----------------
void wakeScreen() {
  if (!screenOn) display.ssd1306_command(SSD1306_DISPLAYON);
  screenOn = true;
  screenOffAt = millis() + SCREEN_ON_MS;
}

void drawScreen() {
  if (!screenOn) return;
  if ((long)(millis() - screenOffAt) > 0) {
    display.clearDisplay();
    display.display();
    display.ssd1306_command(SSD1306_DISPLAYOFF);
    screenOn = false;
    return;
  }
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.printf("%s  %s", callsign[0] ? callsign : "SONDE SAT", device);
  display.drawFastHLine(0, 10, 128, SSD1306_WHITE);
  display.setTextSize(2);
  display.setCursor(0, 15);
  if (!lora.ok()) display.printf("LORA ERR");
  else if (onNetwork()) display.printf("NET %s", net);
  else display.print(joinPending ? "JOIN SENT" : "NO NET");
  display.setTextSize(1);
  display.setCursor(0, 38);
  display.print(phoneConnected ? "Phone connected" : "Phone: waiting (BLE)");
  display.setCursor(0, 52);
  if (isnan(lastRssi)) display.printf("Heard %lu", (unsigned long)heardCount);
  else display.printf("Heard %lu  %.0f dBm", (unsigned long)heardCount, lastRssi);
  display.display();
}

// ---------------- Setup / loop ----------------
void setup() {
  pinMode(VEXT_CTRL, OUTPUT);
  digitalWrite(VEXT_CTRL, LOW);
  delay(100);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  Serial.begin(stk::LINK_BAUD);

  Wire.begin(OLED_SDA, OLED_SCL);
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  wakeScreen();

  stk::deviceId(device);
  netStore.load(net);
  prefs.begin("stk-sat", false);
  strlcpy(callsign, prefs.getString("callsign", "").c_str(), sizeof(callsign));

#if defined(HELTEC_V4_BOARD)
  pinMode(PA_POWER_PIN, OUTPUT);
  digitalWrite(PA_POWER_PIN, HIGH);
  pinMode(PA_ENABLE_PIN, OUTPUT);
  digitalWrite(PA_ENABLE_PIN, HIGH);
  lora.setTxEnablePin(PA_TX_PIN);
#endif
  if (!lora.begin(LORA_POWER_DBM)) {
    char msg[40];
    snprintf(msg, sizeof(msg), "LoRa init failed: %d", lora.error());
    logLine(msg);
  }

  bleRx = xQueueCreate(512, sizeof(char));
  startBluetooth();
  sendId();
}

void loop() {
  char ch;
  while (xQueueReceive(bleRx, &ch, 0) == pdTRUE) {
    if (bleCommands.feed(ch)) handle(bleCommands);
  }
  while (serialCommands.poll(Serial)) handle(serialCommands);
  handleLora();

  static bool wasConnected = false;
  if (phoneConnected != wasConnected) {
    wasConnected = phoneConnected;
    wakeScreen();
  }
  if (digitalRead(BUTTON_PIN) == LOW) wakeScreen();

  static unsigned long lastDraw = 0;
  if (millis() - lastDraw > 250) {
    lastDraw = millis();
    drawScreen();
  }
}
