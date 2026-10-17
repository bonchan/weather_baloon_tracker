// Sonde Tracker link: how companion devices (USB GPS, LoRa tracker...) talk to the
// Sonde Tracker web app over a USB serial port (Web Serial in the browser).
//
// Shared by every sketch in arduino/. From a sketch folder:
//   #include "../common/SondeTrackerLink.h"
// (Arduino IDE 2 resolves the path from the sketch's own folder.)
//
// The app opens the port at LINK_BAUD (native USB boards ignore it, UART bridges need it).
//
// Lines are NMEA 0183 style proprietary sentences, so they can share the port with the raw
// NMEA of a GPS module, and NMEA programs (gpsd, u-center, OpenCPN...) just skip them:
//
//   $PSTK,<type>,<field>,<field>,...*<checksum>\r\n
//
// checksum: XOR of every byte between '$' and '*', as two uppercase hex digits.
// An empty field means unknown / not valid.
//
// Device -> app
//   ID   proto,kind,name,firmware
//        At power-on and in reply to HELLO. kind is KIND_GPS or KIND_LORA.
//   POS  src,fix,sats,hdop,lat,lon,altMsl,geoidSep,speed,course,utc,rssi,snr
//        src        SRC_SELF for the device's own GPS, otherwise the remote tracker's id
//        fix        0 = no data from the GPS module, 1 = searching, 2 = fix
//        sats       satellites used
//        hdop
//        lat, lon   degrees, WGS84
//        altMsl     m above mean sea level
//        geoidSep   m, geoid above the WGS84 ellipsoid (ellipsoid height = altMsl + geoidSep)
//        speed      m/s over ground
//        course     degrees true
//        utc        Unix time of the fix, s
//        rssi, snr  dBm and dB of the radio packet (remote trackers only)
//   LOG  text       human readable; the rest of the line, may contain commas
//   ERR  text       a command was not understood
//
// App -> device (checksum optional, so commands can be typed in a serial monitor)
//   HELLO           -> ID
//
// Readers ignore unknown types and extra trailing fields, so both can be added later
// without breaking older apps. Raise PROTOCOL_VERSION only for incompatible changes.

#pragma once

#include <Arduino.h>
#include <ctype.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

namespace stk {

constexpr uint8_t PROTOCOL_VERSION = 1;
constexpr uint32_t LINK_BAUD = 115200;
constexpr size_t MAX_LINE = 160;   // longest sentence, "*hh\r\n" included

constexpr char KIND_GPS[] = "GPS";
constexpr char KIND_LORA[] = "LORA";
constexpr char SRC_SELF[] = "SELF";

enum Fix : uint8_t { FIX_NO_GPS = 0, FIX_SEARCHING = 1, FIX_OK = 2 };

// One position report. Fields left at their default go out empty.
struct Position {
  const char *src = SRC_SELF;
  Fix fix = FIX_NO_GPS;
  int sats = -1;
  float hdop = NAN;
  double lat = NAN, lon = NAN;
  float altMsl = NAN, geoidSep = NAN;
  float speed = NAN;    // m/s
  float course = NAN;   // degrees true
  uint32_t utc = 0;     // Unix time, 0 = unknown
  float rssi = NAN, snr = NAN;
};

// UTC calendar date and time -> Unix time
inline uint32_t unixTime(int year, int month, int day, int hour, int minute, int second) {
  long y = year - (month <= 2);
  long era = (y >= 0 ? y : y - 399) / 400;
  long yoe = y - era * 400;
  long doy = (153L * (month > 2 ? month - 3 : month + 9) + 2) / 5 + day - 1;
  long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  long days = era * 146097L + doe - 719468L;
  return (uint32_t)days * 86400UL + hour * 3600UL + minute * 60UL + second;
}

// Builds one sentence, then sends it in one piece.
class Sentence : public Print {
 public:
  explicit Sentence(const char *type) {
    buf_[0] = '$';
    print("PSTK,");
    print(type);
  }

  using Print::write;
  size_t write(uint8_t c) override {
    if (len_ >= MAX_LINE - 5) return 0;                              // keep room for "*hh\r\n"
    if (c == '$' || c == '*' || c == '\r' || c == '\n') c = ' ';     // would break the framing
    buf_[len_++] = (char)c;
    sum_ ^= c;
    return 1;
  }

  // Text, or a whole number of any integer type
  Sentence &field(const char *s) {
    write(',');
    if (s) print(s);
    return *this;
  }
  template <typename T>
  Sentence &field(T v) {
    write(',');
    print(v);
    return *this;
  }
  // Decimal number; empty when NaN
  Sentence &field(double v, uint8_t digits) {
    write(',');
    if (!isnan(v)) print(v, digits);
    return *this;
  }
  Sentence &empty() {
    write(',');
    return *this;
  }

  // Sends nothing and returns false when the port has no room (the host isn't reading),
  // so a sketch never blocks on it and lines never get cut in half. The port's TX buffer
  // must hold MAX_LINE bytes (ESP32-S3: USB Mode "Hardware CDC and JTAG", not TinyUSB).
  bool send(Print &out) {
    static const char hex[] = "0123456789ABCDEF";
    buf_[len_] = '*';
    buf_[len_ + 1] = hex[sum_ >> 4];
    buf_[len_ + 2] = hex[sum_ & 15];
    buf_[len_ + 3] = '\r';
    buf_[len_ + 4] = '\n';
    size_t n = len_ + 5;
    if (out.availableForWrite() < (int)n) return false;
    return out.write((const uint8_t *)buf_, n) == n;
  }

 private:
  char buf_[MAX_LINE];
  size_t len_ = 1;
  uint8_t sum_ = 0;
};

inline bool sendId(Print &out, const char *kind, const char *name, const char *firmware) {
  return Sentence("ID").field(PROTOCOL_VERSION).field(kind).field(name).field(firmware).send(out);
}

inline bool sendPosition(Print &out, const Position &p) {
  Sentence s("POS");
  s.field(p.src).field((int)p.fix);
  if (p.sats >= 0) s.field(p.sats);
  else s.empty();
  s.field(p.hdop, 1).field(p.lat, 6).field(p.lon, 6).field(p.altMsl, 1).field(p.geoidSep, 1);
  s.field(p.speed, 2).field(p.course, 1);
  if (p.utc) s.field(p.utc);
  else s.empty();
  s.field(p.rssi, 0).field(p.snr, 1);
  return s.send(out);
}

inline bool sendLog(Print &out, const char *text) { return Sentence("LOG").field(text).send(out); }

inline bool sendError(Print &out, const char *text) { return Sentence("ERR").field(text).send(out); }

// Collects $PSTK command lines from the app. Other lines, and lines with a wrong checksum,
// are dropped.
class CommandReader {
 public:
  // Reads what the port has. Returns true when a command is ready in type() / args(),
  // which stay valid until the next poll().
  bool poll(Stream &in) {
    while (in.available()) {
      char c = (char)in.read();
      if (c == '\r' || c == '\n') {
        bool ready = len_ && !overflow_;
        line_[len_] = 0;
        len_ = 0;
        overflow_ = false;
        if (ready && parse()) return true;
      } else if (len_ < sizeof(line_) - 1) {
        line_[len_++] = c;
      } else {
        overflow_ = true;
      }
    }
    return false;
  }

  const char *type() const { return type_; }
  // Everything after "<type>," ("" when there are no fields)
  const char *args() const { return args_; }
  bool is(const char *type) const { return strcmp(type_, type) == 0; }

 private:
  bool parse() {
    if (strncmp(line_, "$PSTK,", 6) != 0) return false;
    char *star = strrchr(line_, '*');
    if (star) {
      uint8_t sum = 0;
      for (const char *p = line_ + 1; p < star; p++) sum ^= (uint8_t)*p;
      if (!isxdigit(star[1]) || !isxdigit(star[2]) || star[3]) return false;
      if (strtoul(star + 1, nullptr, 16) != sum) return false;
      *star = 0;
    }
    type_ = line_ + 6;
    char *comma = strchr(type_, ',');
    if (comma) {
      *comma = 0;
      args_ = comma + 1;
    } else {
      args_ = "";
    }
    return *type_ != 0;
  }

  char line_[MAX_LINE];
  size_t len_ = 0;
  bool overflow_ = false;
  const char *type_ = "";
  const char *args_ = "";
};

// Passes a GPS module's raw NMEA through to the app one whole sentence at a time, so it
// never gets mixed into a $PSTK line. A sentence is dropped unless the port also has room
// for a $PSTK line after it, so NMEA never crowds out a POS.
class NmeaForwarder {
 public:
  void feed(char c, Print &out) {
    if (c == '$') {   // a sentence starts: resync
      len_ = 0;
      bad_ = false;
    }
    if (len_ == sizeof(buf_)) bad_ = true;
    else buf_[len_++] = c;
    if (c != '\n') return;
    if (!bad_ && buf_[0] == '$' && out.availableForWrite() >= (int)(len_ + MAX_LINE))
      out.write((const uint8_t *)buf_, len_);
    len_ = 0;
    bad_ = false;
  }

 private:
  char buf_[96];   // NMEA sentences are at most 82 characters
  size_t len_ = 0;
  bool bad_ = false;
};

}  // namespace stk
