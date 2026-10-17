# Sonde Tracker

Receive weather balloon radiosondes (400.15–406 MHz) with an RTL-SDR, straight from the browser over WebUSB. No drivers, servers or Python on the receive path.

Current state: **connects to the dongle, live spectrum + waterfall, decodes Vaisala RS41 sondes (position, temperature, humidity) onto an offline map (try *Demo flight* without one), follows you with a USB GPS, English/Spanish UI.** Landing prediction and logging come next.

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
- **Before going out**, open *Map → Offline map*, pick an area (*what the map shows now* or *200 km around the launch site*) and a detail level, then click *Download area*. Zoom 12 (towns and main roads) is a few thousand tiles; 13–14 add street names and take longer. An interrupted download picks up where it stopped.
- **With no internet**, the map shows whatever was saved. Fonts and icons ship with the app in `public/map-assets`.

The saved map belongs to the browser profile and the address (`http://localhost:5173`), so use the same browser in the field. *Delete saved map* frees the space.

**You:** distance, bearing and elevation to the sonde are measured from where you are. With a USB GPS that has a fix, that's the GPS (see below). Otherwise click *Place me* and then the map, or *Use my location*: that covers listening from home with a fixed antenna, and is remembered.

**Launch site:** where sondes go up, Neuquén Aero unless you move it with *Place launch site* and a click on the map. The demo flight starts there, and the offline map can save the area around it.

## GPS companions

Plug a USB GPS into the laptop and the app knows where you are: a yellow marker on the map (an arrow pointing where you're driving; red while no GPS has a fix), and distance, bearing and elevation to the sonde are measured from there throughout the chase.

- **Which GPS**: the Sonde Tracker companions in `arduino/` (ESP32-C3 + NEO-6M, Heltec Wireless Tracker), or any USB GPS that sends NMEA GGA/RMC, like a u-blox USB puck. Several can be connected at once.
- **Connect**: in the sidebar's *GPS companions* panel, click **Connect GPS** and pick the port in the browser's list. This uses Web Serial, so Chrome or Edge on a computer. From then on the app opens it by itself whenever it's plugged in. *Disconnect* stops that until you click *Connect* again, and *Forget* removes the permission.
- **You**: while a GPS has a fix, it is where you are, whatever you placed by hand. If the fix drops (a valley, a tunnel), its last position stays, in red, until the fix returns or you place yourself somewhere newer. Like the sonde's altitude, your height is above the WGS84 ellipsoid when the GPS reports the geoid separation, otherwise above sea level.
- **Follow me** in the map card keeps the map centered on you; **Follow both** pans and zooms to keep you and the sonde in view.
- The panel shows each device's fix, satellites, HDOP, how long since it last sent something, and a companion's latest log lines. Lines that arrive in the first half second after opening were queued in the device while the port was closed, so their positions are skipped.
- Uploading a sketch from the Arduino IDE needs the port: click *Disconnect* in the app first.
- Positions a companion relays for other trackers (any source other than `SELF`) show on the map labelled with the tracker's id.

## LoRa search team

The base station (this web app plus a Heltec Wireless Tracker on USB) and every chaser's phone (the Android app in `android/` plus a Heltec V3/V4 over Bluetooth) form one LoRa network:

```
phone ──Bluetooth──▶ Heltec V3/V4 ──LoRa 915 MHz──▶ Wireless Tracker ──USB──▶ web app
phone ◀─Bluetooth── Heltec V3/V4 ◀─LoRa────────── Wireless Tracker ◀─USB─── web app
```

- The base station owns the network: a random 4-digit id (shown on its screen and in the web app's **LoRa team** panel). Nodes ignore packets from other networks, so two teams on the same frequency don't mix.
- **Joining:** in the phone app, open *Team*, search, connect to the node (`SondeTracker-XXXXXX`), set your name and tap *Ask to join*. The request shows up in the web app's *LoRa team* panel: **Accept** or **Reject**. Once accepted, the node keeps the network in flash, so after a reboot it's still on the team.
- **New network** in the panel starts over: every satellite has to ask again (use it if a node gets lost, or to kick everyone).
- The phone sends its position every 15 s. The base station broadcasts its own position every 10 s, and the web app sends the balloon every 10 s and relays each team member every 30 s, so satellites out of range of each other still see each other.
- **Kick** someone with the × next to their name in the panel; **New network** kicks everyone. Their phones show they are out and can ask again.
- Team members are their **node** (the Heltec's chip id), not their name: renaming on the phone keeps the same member and color. Colors are the same in the web app and on every phone.
- **Clear tracks** or stopping the demo in the web app also clears the balloon on the phones.
- On the phone, the arrow at the bottom points at the balloon with the distance; hold the phone flat. Phones without a compass use the direction of travel while moving.
- It's coordination, not security: anyone with the same settings can listen.

Firmware (Arduino IDE, ESP32 core 3.x, libraries listed at the top of each sketch):

| Board | Sketch | Role |
| --- | --- | --- |
| Heltec Wireless Tracker | `arduino/heltec_weather_baloon_tracker_companion` | base station: USB GPS + LoRa |
| Heltec WiFi LoRa 32 V3 / V4 | `arduino/heltec_companion` (pick the board at the top) | satellite: Bluetooth ↔ LoRa |
| ESP32-C3 + NEO-6M | `arduino/esp32c3_weather_baloon_tracker_companion` | USB GPS only |

The protocol lives in `arduino/common/SondeTrackerLink.h` and the radio settings in `arduino/common/SondeTrackerLora.h`; every sketch includes them, so a new board only needs its own pins and screen.

## Antenna

A quarter-wave vertical cut for 403 MHz has a radiator of about **18 cm** (plus 3–4 radials of the same length angled down). Height and a clear horizon matter more than anything else, especially for catching the landing.

## Development

```bash
pnpm test        # DSP, RS41 decoder, GPS companion and geo unit tests (vitest)
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
- `src/sonde/`: sonde track store (the decoder feeds `addFix()`), the launch site (`launch.ts`, where a pre-launch prediction will start) and the demo flight.
- `src/you.ts`: where you are: the GPS fix, or the pin you placed.
- `src/companion/`: GPS companions. `protocol.ts` (the `$PSTK` link from `arduino/common/SondeTrackerLink.h`, plus NMEA GGA/RMC for plain GPSes), `serial.ts` (Web Serial ports), `store.ts` (devices, my GPS position, remote trackers).
- `src/i18n/`: translations. Add a key to `en.ts` and TypeScript makes you add it to `es.ts` too.

### Roadmap

1. ~~Connect RTL-SDR, live spectrum/waterfall~~
2. ~~Offline map, your position, track display, English/Spanish~~
3. ~~Channelizer: mix the marker to baseband, filter, decimate to 48 kHz, FM-demodulate~~
4. ~~RS41 decoder: frame sync, descrambling, Reed-Solomon, CRC, position/altitude/serial → `sondes.addFix()`~~
5. ~~RS41 temperature and humidity (needs the calibration subframe collected over 51 frames)~~
6. Landing prediction: offline estimate from the descent rate and the winds measured on the way up, and a pre-launch prediction from the launch site
7. Logging (IndexedDB) and export (CSV / GPX / KML)
8. ~~USB GPS: live position from a companion device over Web Serial~~ (firmware in `arduino/`, protocol in `arduino/common/SondeTrackerLink.h`)

## Credits

- Written together with [Claude](https://claude.ai), Anthropic's AI assistant.
- RTL-SDR driver: [webrtlsdr](https://github.com/jtarrio/webrtlsdr) by Jacobo Tarrío.
- Map data © [OpenStreetMap](https://openstreetmap.org/copyright) contributors, tiles by [Protomaps](https://protomaps.com), hosted on [Source Cooperative](https://source.coop), drawn with [MapLibre](https://maplibre.org).
- RS41 format reference: [rs1729/RS](https://github.com/rs1729/RS) by zilog80 and [bazjo/RS41_Decoding](https://github.com/bazjo/RS41_Decoding), whose example frame is in the tests. Frames and calibrations from the rs1729/RS recordings are in the tests too. Temperature and humidity formulas from rs1729's rs41mod.c, with the humidity model worked out by DF9DQ.
