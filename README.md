# Sonde Tracker

Receive weather balloon radiosondes (400.15–406 MHz) with an RTL-SDR, straight from the browser over WebUSB. No drivers, servers or Python on the receive path.

Current state: **connects to the dongle, live spectrum + waterfall, offline map with station and track display (try *Demo flight*), English/Spanish UI.** The RS41 decoder and logging come next.

**Everything runs offline.** All code, fonts and map icons are in this repo or in `node_modules`. The only thing you prepare at home is the map file (below).

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
- **Marker**: click the spectrum or waterfall on a signal. This is where the decoder will listen.

RS41 sondes show up as a narrow signal about 10 kHz wide that transmits continuously. Sondes launch around 11:15 UTC for the 12Z sounding, and on some days around 23:15 UTC. Check https://sondehub.org for recent flights near you to learn the type and frequency.

## Offline map

The map uses a [Protomaps](https://protomaps.com) vector extract (`.pmtiles`, one file) rendered by MapLibre. Fonts and icons are already in `public/map-assets` (re-download with `pnpm map:assets` if needed). Without the file, the map still draws the station and sonde tracks on a blank background.

Prepare it once, with internet:

1. Download the `pmtiles` tool for your OS from https://github.com/protomaps/go-pmtiles/releases (on Windows, `pmtiles_*_Windows_x86_64.zip`) and unzip `pmtiles.exe`.
2. Pick a recent daily build from https://maps.protomaps.com/builds (for example `20261015.pmtiles`).
3. Cut out your area. This box covers Neuquén, Río Negro and the usual eastward drift. Add `--dry-run` first to see the size.

   ```bash
   pmtiles extract https://build.protomaps.com/20261015.pmtiles public/maps/basemap.pmtiles --bbox=-71.5,-41.5,-66,-36 --maxzoom=13
   ```

4. Reload the app. The map is now fully offline. `public/maps/*.pmtiles` is git-ignored, so the file stays local.

Lower `--maxzoom` (11 or 12) for a much smaller file; 13 is enough to read street names when chasing a landing.

**Station:** click *Place station* and then the map, or *Use my location*. Distance, bearing and elevation to the sonde are measured from there.

## Antenna

A quarter-wave vertical cut for 403 MHz has a radiator of about **18 cm** (plus 3–4 radials of the same length angled down). Height and a clear horizon matter more than anything else, especially for catching the landing.

## Development

```bash
pnpm test        # DSP unit tests (vitest)
pnpm lint        # oxlint
pnpm build       # typecheck + production build
```

### Layout

- `src/sdr/device.ts`: WebUSB access through [`@jtarrio/webrtlsdr`](https://github.com/jtarrio/webrtlsdr). Serialized config and a continuous stream with 2 bulk transfers in flight.
- `src/sdr/controller.ts`: app-level owner of the dongle and the DSP worker. React reads it via `useSyncExternalStore`.
- `src/dsp/`: runs in a Web Worker. FFT, averaged power spectrum, noise floor, peak, clipping.
- `src/components/`: UI. `spectrumRenderer.ts` draws the spectrum and waterfall on canvases outside React.
- `src/map/`: offline MapLibre map (PMTiles basemap, local glyphs/sprites), sonde info card.
- `src/sonde/`: sonde track store (`addFix()` is what the decoder will call) and the demo flight.
- `src/i18n/`: translations. Add a key to `en.ts` and TypeScript makes you add it to `es.ts` too.

### Roadmap

1. ~~Connect RTL-SDR, live spectrum/waterfall~~
2. ~~Offline map, station, track display, English/Spanish~~
3. Channelizer: mix the marker to baseband, filter, decimate to 48 kHz, FM-demodulate
4. RS41 decoder: frame sync, descrambling, Reed-Solomon, CRC, position/altitude/PTU/serial → `sondes.addFix()`
5. Landing prediction: offline estimate from the descent rate and the winds measured on the way up
6. Logging (IndexedDB) and export (CSV / GPX / KML)
