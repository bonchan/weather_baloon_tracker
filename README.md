# Sonde Tracker

Receive weather balloon radiosondes (400.15–406 MHz) with an RTL-SDR, straight from the browser over WebUSB. No drivers, servers or Python on the receive path.

Current state: **connects to the dongle, live spectrum + waterfall, decodes Vaisala RS41 sondes (position, temperature, humidity) onto an offline map (try *Demo flight* without one), English/Spanish UI.** Landing prediction and logging come next.

**Everything runs offline.** All code, fonts and map icons are in this repo or in `node_modules`. The only thing to prepare at home is downloading the map area you need, from inside the app (see below).

## Run it

```bash
pnpm install
pnpm dev
```

Open **http://localhost:5173 in Chrome or Edge** (Firefox and Safari have no WebUSB). WebUSB only works on `localhost` or HTTPS, so opening the page from another machine over a LAN IP won't work.

Click **Connect RTL-SDR** and pick the dongle in the browser's list. After the first time, the browser remembers the permission and Connect skips the picker.

## One-time dongle setup

### Windows: WinUSB driver (Zadig)

Chrome can only claim the dongle when it uses the WinUSB driver. If you've used it with SDR#, SDR++ or rtl_tcp before, this is probably already done.

1. Download Zadig from https://zadig.akeo.ie and run it.
2. **Options → List All Devices**.
3. Pick **Bulk-In, Interface (Interface 0)** (sometimes listed as *RTL2838UHIDIR* or *RTL2832U*). Make sure the USB ID shows `0BDA 2838` or `0BDA 2832`.
4. Select **WinUSB** as the target driver and click **Replace Driver**.
5. Unplug and replug the dongle.

If the dongle doesn't show up in Chrome's picker, or Connect fails with "Access denied", the driver is the usual cause.

### Linux

```bash
echo 'blacklist dvb_usb_rtl28xxu' | sudo tee /etc/modprobe.d/blacklist-rtl.conf
echo 'SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="283[28]", MODE="0666"' | sudo tee /etc/udev/rules.d/20-rtlsdr.rules
sudo udevadm control --reload-rules
```

Then replug the dongle.

### Only one program at a time

Close SDR#, SDR++, rtl_tcp, or other tabs of this page before connecting. Only one of them can hold the dongle.

## Supported hardware

RTL2832U dongles with an R820T, R820T2, R860 or R828D tuner: RTL-SDR Blog V3/V4, NooElec NESDR, and most generic sticks. Old E4000/FC0012 tuners are not supported.

## Using the receiver

- **Sonde band hops**: centers that cover 400.15–406 MHz with the current sample rate. Click through them to look for a sonde.
- **Sample rate**: 2.4 MS/s is the widest rate that stays reliable. If **USB rate** in the Signal panel drops below ~98%, samples are being lost, so lower it.
- **Gain**: start with Auto. For weak or distant sondes, try manual gain around 35–45 dB. If **ADC clipping** goes above ~0.1%, lower the gain.
- **Frequency correction (ppm)**: TCXO dongles (Blog V3/V4) are within about 1 ppm. Cheap ones can be 30–60 ppm off, so tune a known signal and adjust until it lands on its frequency.
- **Marker**: click the spectrum or waterfall on a signal. This is where the decoder listens.

RS41 sondes show up as a narrow signal about 10 kHz wide that transmits continuously.

## Decoding an RS41

Put the marker on the sonde's signal, ideally with **Center on marker** so it sits clear of the DC spike in the middle. The **RS41 decoder** rows in the Signal panel show what it hears:

- **searching…**: no frame header yet. Check the marker is on the signal.
- **sync, frames failing**: headers arrive but the frames are too damaged. Usually a weak signal: improve the antenna or try another gain.
- **locked**: good frames are coming in (one per second). The serial and frame number show up, and positions go to the map.

Temperature and humidity need the sonde's factory calibration, which it sends in 51 pieces, one per frame. **Calibration** counts them. Temperature shows up within the first minute, and humidity once most of it is in. If you move the marker away and come back, nothing is lost. Humidity uses the same formula as radiosonde_auto_rx, so it should match what SondeHub shows.

The marker doesn't need to be exact: a sonde up to ±4 kHz off still decodes, and after the first good frame the decoder follows it (*Sonde offset*). A sonde on the ground without a GPS fix yet decodes but has no position to map. Encrypted RS41-SGM (military) sondes decode but their position cannot be read. Sondes launch around 11:15 UTC for the 12Z sounding, and on some days around 23:15 UTC. Check https://sondehub.org for recent flights near you to learn the type and frequency.

## Offline map

The map is OpenStreetMap data ([Protomaps](https://protomaps.com) vector tiles) drawn by MapLibre. The app downloads tiles straight from the public [Source Cooperative](https://source.coop/protomaps/openstreetmap) mirror and **stores them inside the browser** (IndexedDB). No extra program and no API key, and it works the same on Windows, Linux and macOS.

- **While online**, every part of the map you look at is saved automatically.
- **Before going out**, open *Map → Offline map*, pick an area (*what the map shows now* or *200 km around the station*) and a detail level, then click *Download area*. Zoom 12 (towns and main roads) is a few thousand tiles; 13–14 add street names and take longer. An interrupted download picks up where it stopped.
- **With no internet**, the map shows whatever was saved. Fonts and icons ship with the app in `public/map-assets`.

The saved map belongs to the browser profile and the address (`http://localhost:5173`), so use the same browser in the field. *Delete saved map* frees the space.

**Station:** click *Place station* and then the map, or *Use my location*. Distance, bearing and elevation to the sonde are measured from there.

## Antenna

A quarter-wave vertical cut for 403 MHz has a radiator of about **18 cm** (plus 3–4 radials of the same length angled down). Height and a clear horizon matter more than anything else, especially for catching the landing.

## Development

```bash
pnpm test        # DSP, RS41 decoder and geo unit tests (vitest)
pnpm lint        # oxlint
pnpm build       # typecheck + production build
```

### Layout

- `src/sdr/device.ts`: WebUSB access through [`@jtarrio/webrtlsdr`](https://github.com/jtarrio/webrtlsdr). Serialized config and a continuous stream with 2 bulk transfers in flight.
- `src/sdr/controller.ts`: app-level owner of the dongle and the DSP worker. React reads it via `useSyncExternalStore`.
- `src/dsp/`: runs in a Web Worker. FFT, averaged power spectrum, noise floor, peak, clipping. `channelizer.ts` mixes the marker to baseband, filters and decimates to ~48 kHz, and FM-demodulates.
- `src/sonde/rs41/`: the RS41 decoder, also in the worker. `demod.ts` (4800 baud GFSK symbol timing and header sync), `frame.ts` (Reed-Solomon, CRC, block parsing), `ptu.ts` (calibration, temperature, humidity), `receiver.ts` (the whole chain, AFC, status). `synthetic.ts` builds and modulates fake frames for the tests.
- `src/components/`: UI. `spectrumRenderer.ts` draws the spectrum and waterfall on canvases outside React.
- `src/map/`: MapLibre map, tile protocol with IndexedDB cache and area downloads (`tiles.ts`, `tileCache.ts`), sonde info card.
- `src/sonde/`: sonde track store (the decoder feeds `addFix()`) and the demo flight.
- `src/i18n/`: translations. Add a key to `en.ts` and TypeScript makes you add it to `es.ts` too.

### Roadmap

1. ~~Connect RTL-SDR, live spectrum/waterfall~~
2. ~~Offline map, station, track display, English/Spanish~~
3. ~~Channelizer: mix the marker to baseband, filter, decimate to 48 kHz, FM-demodulate~~
4. ~~RS41 decoder: frame sync, descrambling, Reed-Solomon, CRC, position/altitude/serial → `sondes.addFix()`~~
5. ~~RS41 temperature and humidity (needs the calibration subframe collected over 51 frames)~~
6. Landing prediction: offline estimate from the descent rate and the winds measured on the way up
7. Logging (IndexedDB) and export (CSV / GPX / KML)
8. USB GPS: live station position from a companion device. The Arduino side is done: `arduino/esp32c3_weather_balook_tracker_companion` (ESP32-C3 + NEO-6M) and `arduino/heltec_weather_balook_tracker_companion` (Heltec Wireless Tracker, shows the fix and link on its screen). Open it with Web Serial (Chrome/Edge, USB vendor `0x303A` for both), send `$PSTK,HELLO`, and feed `$PSTK,POS` lines with src `SELF` to `sondes.setStation()`, altitude = `altMsl + geoidSep`. Skip the raw NMEA lines it also passes through, resync on `$`, and drop POS lines whose `utc` is more than a few seconds old (the USB buffer still holds lines from before the port opened). The protocol is in `arduino/common/SondeTrackerLink.h`, GPS reporting in `arduino/common/SondeTrackerGps.h`.

## Credits

- Written together with [Claude](https://claude.ai), Anthropic's AI assistant.
- RTL-SDR driver: [webrtlsdr](https://github.com/jtarrio/webrtlsdr) by Jacobo Tarrío.
- Map data © [OpenStreetMap](https://openstreetmap.org/copyright) contributors, tiles by [Protomaps](https://protomaps.com), hosted on [Source Cooperative](https://source.coop), drawn with [MapLibre](https://maplibre.org).
- RS41 format reference: [rs1729/RS](https://github.com/rs1729/RS) by zilog80 and [bazjo/RS41_Decoding](https://github.com/bazjo/RS41_Decoding), whose example frame is in the tests. Frames and calibrations from the rs1729/RS recordings are in the tests too. Temperature and humidity formulas from rs1729's rs41mod.c, with the humidity model worked out by DF9DQ.
