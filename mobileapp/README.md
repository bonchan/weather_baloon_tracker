# Sonde Tracker – mobile

Phone app for the search team. It pairs over Bluetooth with a Heltec V3/V4 running `arduino/heltec_companion` and shows, on a map:

- **you** (the phone's GPS), sent to the network every 10–60 s
- the **other satellites** (team members) heard over LoRa
- the **base station** (laptop + Heltec Wireless Tracker running the web app)
- the **balloon** the base station is decoding, with its track

Expo SDK 58, expo-router, MapLibre, react-native-ble-plx. Spanish and English.

## The network

```
phone ──BLE──▶ Heltec V3/V4 ──LoRa 915 MHz──▶ base Heltec ──USB──▶ web app (decodes the sonde)
phone ◀─BLE── Heltec V3/V4 ◀─LoRa────────── base Heltec ◀─USB─── web app
```

Every LoRa packet is one `$PSTK` line (`src/protocol/pstk.ts`, same format as `arduino/common/SondeTrackerLink.h`):

| Line | Who sends it |
| --- | --- |
| `$PSTK,POS,<callsign>,fix,sats,hdop,lat,lon,alt,,speed,course,utc*hh` | each phone (through its Heltec) |
| `$PSTK,POS,BASE,…` | the base station, its own position |
| `$PSTK,SONDE,serial,frame,lat,lon,alt,climb,speed,course,utc*hh` | the base station, for the balloon |

The base station also re-sends what it hears from each satellite, so team members out of range of each other still see each other.

## Build an APK (Android)

The app uses Bluetooth and a native map, so it can't run in Expo Go; it needs its own build. EAS builds it in the cloud: no Java or Android Studio needed.

1. Create a free account at https://expo.dev/signup.
2. From this folder:

   ```bash
   npx eas-cli@latest login
   ```

3. First build (it asks to create the project on your account and to generate an Android keystore: say yes to both):

   ```bash
   npx eas-cli@latest build -p android --profile development
   ```

4. When it finishes (10–20 min), open the link it prints on the phone, download the APK and install it (allow "install unknown apps" for the browser).
5. Start the dev server on the PC, phone on the same Wi-Fi:

   ```bash
   pnpm start
   ```

   Open the app on the phone; it finds the server, or scan the QR code shown in the terminal.

For friends, build a standalone APK that doesn't need the PC:

```bash
npx eas-cli@latest build -p android --profile preview
```

Share the link or the `.apk` file. Android 7.0 or newer.

## Develop

```bash
pnpm test        # protocol tests (vitest)
pnpm lint
npx tsc --noEmit
```

Rebuild with EAS only when native dependencies or `app.json` change; JavaScript changes reload over Wi-Fi.

## Next

- Offline map areas on the phone (the map is online for now).
- Base station: web app sends `POS,BASE` and `SONDE` lines through the Heltec Wireless Tracker; firmware relays LoRa ↔ USB.
