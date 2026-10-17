#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <RadioLib.h>
#include <NimBLEDevice.h>

// ============================================================================
// HARDWARE BOARD SELECTION & PIN CONFIGURATION
// ============================================================================
// Uncomment ONLY ONE of the two lines below:
#define HELTEC_V3_BOARD
// #define HELTEC_V4_BOARD

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64

#define OLED_SDA     17
#define OLED_SCL     18
#define OLED_RST     21
#define VEXT_CTRL    36  // Controls power to OLED & external peripherals
#define BUTTON_PIN   0   // Onboard PRG/USER Button

#if defined(HELTEC_V3_BOARD)
  #define LORA_NSS   8
  #define LORA_SCK   9
  #define LORA_MOSI  10
  #define LORA_MISO  11
  #define LORA_RST   12
  #define LORA_BUSY  13
  #define LORA_DIO1  14
  #define MAX_POWER  22  // dBm
#elif defined(HELTEC_V4_BOARD)
  #define LORA_NSS   8
  #define LORA_SCK   9
  #define LORA_MOSI  10
  #define LORA_MISO  11
  #define LORA_RST   12
  #define LORA_BUSY  13
  #define LORA_DIO1  14
  #define MAX_POWER  28  // dBm (External GC1109 PA)
#endif

// ============================================================================
// GLOBAL INSTANCES & STATE VARIABLES
// ============================================================================
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RST);

SPIClass loraSPI(FSPI);
SX1262 radio = new Module(LORA_NSS, LORA_DIO1, LORA_RST, LORA_BUSY, loraSPI);

// BLE GATT Service Definitions (UART style)
#define SERVICE_UUID        "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_RX   "6E400002-B5A3-F393-E0A9-E50E24DCCA9E" // Write from Phone
#define CHARACTERISTIC_TX   "6E400003-B5A3-F393-E0A9-E50E24DCCA9E" // Notify to Phone

NimBLECharacteristic* pTxCharacteristic = nullptr;
bool deviceConnected = false;
bool loraInitialized = false;

// Non-blocking LoRa interrupt flag
volatile bool loraPacketReceived = false;

// Display and timing control
unsigned long lastSerialPrint = 0;
unsigned long screenOffTime = 0;
bool screenIsOn = false;
uint32_t rxPacketCount = 0;

// Function Prototypes
void wakeScreen();
void sleepScreen();
void updateDisplayStatus(const char* statusText, const char* extraInfo = "");
void IRAM_ATTR setLoRaRxFlag();

// ============================================================================
// BLE CALLBACK CLASSES
// ============================================================================
class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* pServer) override {
    deviceConnected = true;
    Serial.println("BLE: Mobile app connected!");
    if (screenIsOn) updateDisplayStatus("BLE Connected");
  }
  
  void onDisconnect(NimBLEServer* pServer) override {
    deviceConnected = false;
    Serial.println("BLE: Mobile app disconnected! Advertising restarted...");
    NimBLEDevice::startAdvertising();
    if (screenIsOn) updateDisplayStatus("BLE Waiting...");
  }
};

class RxCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* pCharacteristic) override {
    std::string rxValue = pCharacteristic->getValue();
    if (rxValue.length() > 0) {
      Serial.printf("BLE RX -> Transmitting over LoRa (%d bytes): %s\n", 
                    rxValue.length(), rxValue.c_str());

      // Transmit payload received from Phone directly over LoRa radio
      int state = radio.transmit((uint8_t*)rxValue.data(), rxValue.length());
      
      if (state == RADIOLIB_ERR_NONE) {
        Serial.println("LoRa TX: Packet sent successfully.");
      } else {
        Serial.printf("LoRa TX: Failed with error code %d\n", state);
      }

      // Resume continuous non-blocking listening mode
      radio.startReceive();
    }
  }
};

// ============================================================================
// SETUP
// ============================================================================
void setup() {
  // 1. Enable Vext Power Rail for OLED & Peripherals
  pinMode(VEXT_CTRL, OUTPUT);
  digitalWrite(VEXT_CTRL, LOW); // LOW turns ON Vext rail on Heltec boards
  delay(100);

  // 2. Configure USER Button
  pinMode(BUTTON_PIN, INPUT_PULLUP);

  // 3. Initialize Serial Communication
  Serial.begin(115200);
  unsigned long startWait = millis();
  while (!Serial && (millis() - startWait < 3000)) {
    delay(10);
  }
  Serial.println("\n--- HELTEC NODE INITIALIZING ---");

  // 4. Initialize OLED Display
  Wire.begin(OLED_SDA, OLED_SCL);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("ERROR: OLED Display initialization failed!");
  } else {
    Serial.println("SUCCESS: OLED Display initialized.");
    wakeScreen();
  }

  // 5. Initialize SPI & LoRa Transceiver
  loraSPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_NSS);
  int loraState = radio.begin(915.0, 125.0, 9, 7, 0x12, MAX_POWER);
  
  if (loraState == RADIOLIB_ERR_NONE) {
    loraInitialized = true;
    Serial.println("SUCCESS: LoRa Radio initialized @ 915 MHz.");
    
    // Set non-blocking interrupt callback on DIO1 pin for received packets
    radio.setDio1Action(setLoRaRxFlag);
    radio.startReceive(); // Put radio into continuous receive mode
  } else {
    Serial.printf("ERROR: LoRa init failed, code: %d\n", loraState);
  }

  // 6. Initialize NimBLE Stack
  NimBLEDevice::init("Heltec-MeshNode");
  NimBLEServer* pServer = NimBLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  NimBLEService* pService = pServer->createService(SERVICE_UUID);

  pTxCharacteristic = pService->createCharacteristic(
    CHARACTERISTIC_TX,
    NIMBLE_PROPERTY::NOTIFY
  );

  NimBLECharacteristic* pRxCharacteristic = pService->createCharacteristic(
    CHARACTERISTIC_RX,
    NIMBLE_PROPERTY::WRITE
  );
  pRxCharacteristic->setCallbacks(new RxCallbacks());

  pService->start();
  NimBLEAdvertising* pAdvertising = NimBLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->start();

  Serial.println("SUCCESS: BLE GATT Server initialized & advertising.");
  updateDisplayStatus("Node Ready", "BLE Advertising");
}

// ============================================================================
// MAIN LOOP
// ============================================================================
void loop() {
  unsigned long currentMillis = millis();

  // --- 1. Handle Incoming LoRa Packets (Triggered by Interrupt) ---
  if (loraPacketReceived) {
    loraPacketReceived = false;

    String rxStr;
    int state = radio.readData(rxStr);

    if (state == RADIOLIB_ERR_NONE) {
      rxPacketCount++;
      float rssi = radio.getRSSI();
      float snr = radio.getSNR();

      Serial.printf("LoRa RX [#%u] | RSSI: %.1f dBm | SNR: %.1f dB | Payload: %s\n", 
                    rxPacketCount, rssi, snr, rxStr.c_str());

      // Forward received packet to Expo app via BLE Notify
      if (deviceConnected && pTxCharacteristic != nullptr) {
        pTxCharacteristic->setValue((uint8_t*)rxStr.c_str(), rxStr.length());
        pTxCharacteristic->notify();
        Serial.println("BLE TX: Forwarded LoRa packet to phone.");
      }

      // Briefly wake up screen to alert user of incoming message
      wakeScreen();
      char extraBuffer[32];
      snprintf(extraBuffer, sizeof(extraBuffer), "RSSI: %.0f dBm", rssi);
      updateDisplayStatus("Packet Recv!", extraBuffer);

    } else if (state == RADIOLIB_ERR_CRC_MISMATCH) {
      Serial.println("LoRa RX Error: CRC Mismatch!");
    } else {
      Serial.printf("LoRa RX Error code: %d\n", state);
    }

    // Re-enable continuous RX listening
    radio.startReceive();
  }

  // --- 2. Check User Button (Manual Screen Wake) ---
  if (digitalRead(BUTTON_PIN) == LOW) {
    delay(50); // Debounce
    if (digitalRead(BUTTON_PIN) == LOW) {
      Serial.println("ACTION: User button pressed. Waking screen...");
      wakeScreen();
      while(digitalRead(BUTTON_PIN) == LOW); // Wait for release
    }
  }

  // --- 3. Auto Screen Sleep Timeout ---
  if (screenIsOn && (currentMillis >= screenOffTime)) {
    sleepScreen();
  }

  // --- 4. 10-Second Heartbeat Logging ---
  if (currentMillis - lastSerialPrint >= 10000) {
    lastSerialPrint = currentMillis;

    Serial.printf("[HEARTBEAT] Uptime: %lu s | BLE: %s | LoRa Packets RX: %u | Free Heap: %u bytes\n", 
                  currentMillis / 1000, 
                  deviceConnected ? "Connected" : "Disconnected", 
                  rxPacketCount,
                  ESP.getFreeHeap());

    if (screenIsOn) {
      updateDisplayStatus(deviceConnected ? "BLE: Connected" : "BLE: Idle");
    }
  }
}

// ============================================================================
// HELPER & DISPLAY FUNCTIONS
// ============================================================================

// Interrupt Service Routine (ISR) triggered by RadioLib on DIO1 pin
void IRAM_ATTR setLoRaRxFlag() {
  loraPacketReceived = true;
}

void wakeScreen() {
  display.ssd1306_command(SSD1306_DISPLAYON);
  screenIsOn = true;
  screenOffTime = millis() + 5000; // Keep screen on for 5 seconds
}

void sleepScreen() {
  display.clearDisplay();
  display.display();
  display.ssd1306_command(SSD1306_DISPLAYOFF);
  screenIsOn = false;
  Serial.println("INFO: OLED screen entered sleep mode.");
}

void updateDisplayStatus(const char* statusText, const char* extraInfo) {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  
  display.setCursor(0, 0);
  display.println("HELTEC MESH NODE");
  display.drawFastHLine(0, 10, 128, SSD1306_WHITE);

  display.setCursor(0, 20);
  display.printf("Status: %s\n", statusText);

  if (strlen(extraInfo) > 0) {
    display.setCursor(0, 32);
    display.println(extraInfo);
  }

  display.setCursor(0, 44);
  display.printf("BLE: %s", deviceConnected ? "CONNECTED" : "WAITING");

  display.setCursor(0, 54);
  display.printf("RX Pkts: %u", rxPacketCount);

  display.display();
}