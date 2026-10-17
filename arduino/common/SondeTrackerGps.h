// Reports a GPS module to the Sonde Tracker app: reads it with TinyGPSPlus and sends a
// $PSTK,POS line after each fix (see SondeTrackerLink.h), plus the module's raw NMEA.
// Shared by the sketches that have their own GPS:
//   #include "../common/SondeTrackerGps.h"
//
// Library (Library Manager): "TinyGPSPlus" (Mikal Hart).

#pragma once

#include <TinyGPSPlus.h>
#include "SondeTrackerLink.h"

namespace stk {

class GpsReporter {
 public:
  static constexpr unsigned long SILENT_MS = 3000;     // no valid sentence for this long = no GPS
  static constexpr unsigned long MAX_AGE_MS = 3000;    // older position = fix lost
  static constexpr unsigned long FALLBACK_MS = 1500;   // POS at least this often, even with a silent module

  TinyGPSPlus gps;

  // passNmea: also send the module's raw NMEA to the port, so NMEA programs can use it
  explicit GpsReporter(bool passNmea = true)
      : passNmea_(passNmea), sepGP_(gps, "GPGGA", 11), sepGN_(gps, "GNGGA", 11) {}

  // Call from loop(). Reads what the module sent and sends a POS after each GGA (once per
  // fix), or every FALLBACK_MS while the module is silent. Returns true when a POS was due.
  bool poll(Stream &module, Print &out) {
    while (module.available()) {
      char c = (char)module.read();
      if (passNmea_) nmea_.feed(c, out);
      if (gps.encode(c)) {   // a sentence with a good checksum
        talking_ = true;
        lastSentence_ = millis();
      }
    }
    if (!gps.satellites.isUpdated() && millis() - lastSent_ < FALLBACK_MS) return false;
    last_ = read();
    delivered_ = sendPosition(out, last_);
    lastSent_ = millis();
    return true;
  }

  Fix fix() {
    if (!talking_ || millis() - lastSentence_ > SILENT_MS) return FIX_NO_GPS;
    if (gps.location.isValid() && gps.location.age() < MAX_AGE_MS) return FIX_OK;
    return FIX_SEARCHING;
  }

  // The last POS sent
  const Position &last() const { return last_; }
  // false when the last POS didn't fit in the port, i.e. nobody is reading it
  bool delivered() const { return delivered_; }

 private:
  Position read() {
    Position p;
    p.fix = fix();
    int sats = gps.satellites.isValid() ? gps.satellites.value() : -1;   // reading clears isUpdated()
    if (p.fix != FIX_NO_GPS) {
      p.sats = sats;
      if (gps.hdop.isValid()) p.hdop = gps.hdop.hdop();
      if (gps.date.isValid() && gps.time.isValid() && gps.date.year() >= 2020)
        p.utc = unixTime(gps.date.year(), gps.date.month(), gps.date.day(),
                         gps.time.hour(), gps.time.minute(), gps.time.second());
    }
    if (p.fix == FIX_OK) {
      p.lat = gps.location.lat();
      p.lon = gps.location.lng();
      if (fresh(gps.altitude)) p.altMsl = gps.altitude.meters();
      if (fresh(gps.speed)) p.speed = gps.speed.mps();
      if (fresh(gps.course)) p.course = gps.course.deg();
      TinyGPSCustom &sep = sepGN_.age() < sepGP_.age() ? sepGN_ : sepGP_;
      if (sep.isValid() && sep.age() < MAX_AGE_MS && sep.value()[0]) p.geoidSep = atof(sep.value());
    }
    return p;
  }

  static bool fresh(TinyGPSDecimal &v) { return v.isValid() && v.age() < MAX_AGE_MS; }

  bool passNmea_;
  TinyGPSCustom sepGP_, sepGN_;   // geoid separation, which TinyGPSPlus doesn't parse (GN: multi-GNSS)
  NmeaForwarder nmea_;
  Position last_;
  bool talking_ = false, delivered_ = false;
  unsigned long lastSentence_ = 0, lastSent_ = 0;
};

}  // namespace stk
