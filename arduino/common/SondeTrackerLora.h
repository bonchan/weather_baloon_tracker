// Sonde Tracker over LoRa: the radio settings, framing and team network every LoRa sketch
// shares (protocol in SondeTrackerLink.h). Change a setting here and every node follows.
//   #include "../common/SondeTrackerLora.h"
//
// Library (Library Manager): "RadioLib" (Jan Gromes).

#pragma once

#include <Preferences.h>
#include <RadioLib.h>
#include <SPI.h>
#include "SondeTrackerLink.h"

namespace stk {

// Every node of a team must use the same values. 915 MHz band (Americas); SF9 / 125 kHz is a
// few km between cars and ~0.3 s on air for a POS.
constexpr float LORA_FREQ_MHZ = 915.0;
constexpr float LORA_BW_KHZ = 125.0;
constexpr uint8_t LORA_SF = 9;
constexpr uint8_t LORA_CR = 7;              // coding rate 4/7
constexpr uint8_t LORA_SYNC_WORD = 0x12;    // private networks (0x34 is LoRaWAN)
constexpr uint16_t LORA_PREAMBLE = 8;
constexpr float LORA_TCXO_V = 1.8;          // Heltec boards feed the SX1262's TCXO from DIO3
constexpr size_t LORA_MAX_PACKET = MAX_LINE + NET_LEN + 2;

struct LoraPins {
  int8_t nss, sck, mosi, miso, rst, busy, dio1;
};
// Heltec WiFi LoRa 32 V3 / V4 and Wireless Tracker wire their SX1262 the same way.
constexpr LoraPins HELTEC_LORA_PINS = {8, 9, 10, 11, 12, 13, 14};

namespace detail {
// static, not inline: the ESP32 linker can't place an inline IRAM function's literals.
// Each sketch is one translation unit, so there is one copy.
static volatile bool loraIrq = false;
static void IRAM_ATTR onLoraIrq() { loraIrq = true; }
}  // namespace detail

// Collects a sentence in memory instead of a port, to send it over the air.
class LineBuffer : public Print {
 public:
  size_t write(uint8_t c) override {
    if (c == '\r' || c == '\n' || len_ >= sizeof(buf_) - 1) return 1;
    buf_[len_++] = (char)c;
    buf_[len_] = 0;
    return 1;
  }
  int availableForWrite() override { return (int)(sizeof(buf_) - 1 - len_); }
  const char *c_str() const { return buf_; }
  void clear() {
    len_ = 0;
    buf_[0] = 0;
  }

 private:
  char buf_[MAX_LINE + 1] = {0};
  size_t len_ = 0;
};

class LoraLink {
 public:
  explicit LoraLink(const LoraPins &pins)
      : pins_(pins), spi_(HSPI), radio_(new Module(pins.nss, pins.dio1, pins.rst, pins.busy, spi_)) {}

  // powerDbm: the SX1262's own output, -9..22 (an external PA, like the V4's, adds to it).
  bool begin(int8_t powerDbm) {
    spi_.begin(pins_.sck, pins_.miso, pins_.mosi, pins_.nss);
    error_ = radio_.begin(LORA_FREQ_MHZ, LORA_BW_KHZ, LORA_SF, LORA_CR, LORA_SYNC_WORD, powerDbm,
                          LORA_PREAMBLE, LORA_TCXO_V);
    if (error_ != RADIOLIB_ERR_NONE) return false;
    radio_.setDio2AsRfSwitch(true);
    radio_.setPacketReceivedAction(detail::onLoraIrq);
    ok_ = true;
    listen();
    return true;
  }

  // Boards with an external PA (Heltec V4) switch it to transmit with a GPIO. Call before begin().
  void setTxEnablePin(int8_t pin) { radio_.setRfSwitchPins(RADIOLIB_NC, pin); }

  bool ok() const { return ok_; }
  int error() const { return error_; }

  // Sends "@<net> $<body>*hh". body is a sentence without "$" and "*hh", e.g. "PSTK,POS,...".
  bool sendBody(const char *net, const char *body) {
    uint8_t sum = 0;
    for (const char *c = body; *c; c++) sum ^= (uint8_t)*c;
    char frame[LORA_MAX_PACKET + 4];
    int n = snprintf(frame, sizeof(frame), "@%s $%s*%02X", net, body, sum);
    if (n <= 0 || n >= (int)sizeof(frame)) return false;
    return transmit(frame, (size_t)n);
  }

  // Sends a whole sentence ("$...*hh", e.g. from a LineBuffer) on network net.
  bool sendLine(const char *net, const char *line) {
    char frame[LORA_MAX_PACKET + 4];
    int n = snprintf(frame, sizeof(frame), "@%s %s", net, line);
    if (n <= 0 || n >= (int)sizeof(frame)) return false;
    return transmit(frame, (size_t)n);
  }

  // Call from loop(). True when a well-formed packet arrived: see net(), body(), rssi(), snr().
  bool poll() {
    if (!ok_ || !detail::loraIrq) return false;
    detail::loraIrq = false;
    size_t len = radio_.getPacketLength();
    if (len == 0 || len >= sizeof(rx_)) {
      listen();
      return false;
    }
    int state = radio_.readData((uint8_t *)rx_, len);
    rssi_ = radio_.getRSSI();
    snr_ = radio_.getSNR();
    listen();
    if (state != RADIOLIB_ERR_NONE) return false;
    rx_[len] = 0;
    // "@NNNN $...*hh"
    if (len < NET_LEN + 3 || rx_[0] != '@' || rx_[NET_LEN + 1] != ' ') return false;
    memcpy(net_, rx_ + 1, NET_LEN);
    net_[NET_LEN] = 0;
    body_ = checkedBody(rx_ + NET_LEN + 2);
    return body_ != nullptr;
  }

  const char *net() const { return net_; }
  // The sentence without "$" and "*hh", e.g. "PSTK,JOIN,A1B2C3,JUAN"
  const char *body() const { return body_; }
  float rssi() const { return rssi_; }
  float snr() const { return snr_; }
  // True when body() is a sentence of this type ("POS", "JOIN"...)
  bool is(const char *type) const {
    size_t n = strlen(type);
    return body_ && strncmp(body_, "PSTK,", 5) == 0 && strncmp(body_ + 5, type, n) == 0 &&
           (body_[5 + n] == ',' || body_[5 + n] == 0);
  }
  // The fields after the type ("" when none)
  const char *args() const {
    const char *c = body_ ? strchr(body_ + 5, ',') : nullptr;
    return c ? c + 1 : "";
  }

 private:
  bool transmit(const char *frame, size_t len) {
    if (!ok_) return false;
    int state = radio_.transmit((const uint8_t *)frame, len);
    detail::loraIrq = false;   // the TX-done interrupt isn't a packet
    listen();
    return state == RADIOLIB_ERR_NONE;
  }

  void listen() { radio_.startReceive(); }

  LoraPins pins_;
  SPIClass spi_;   // its own SPI bus, so it can share the chip with a display on the default one
  SX1262 radio_;
  bool ok_ = false;
  int error_ = 0;
  char rx_[LORA_MAX_PACKET + 4];
  char net_[NET_LEN + 1] = {0};
  char *body_ = nullptr;
  float rssi_ = 0, snr_ = 0;
};

// The team network id, kept in flash across reboots.
class NetStore {
 public:
  // Loads the saved net into out; NO_NET when there is none.
  void load(char out[NET_LEN + 1]) {
    prefs_.begin("stk", true);
    String s = prefs_.getString("net", NO_NET);
    prefs_.end();
    strlcpy(out, s.length() == NET_LEN ? s.c_str() : NO_NET, NET_LEN + 1);
  }
  void save(const char *net) {
    prefs_.begin("stk", false);
    prefs_.putString("net", net);
    prefs_.end();
  }
  // A fresh random id (never NO_NET).
  static void random(char out[NET_LEN + 1]) {
    snprintf(out, NET_LEN + 1, "%04X", (unsigned)(esp_random() & 0xFFFF));
  }

 private:
  Preferences prefs_;
};

inline bool validNet(const char *s) {
  if (strlen(s) != NET_LEN) return false;
  for (size_t i = 0; i < NET_LEN; i++)
    if (!isxdigit(s[i])) return false;
  return true;
}

}  // namespace stk
