import { describe, expect, it } from 'vitest'
import { decodeFrame } from './frame'
import { STANDARD_LENGTH } from './protocol'
import {
  CALIBRATION_SUBFRAMES,
  humidity,
  HUMIDITY_SENSOR,
  pressure,
  readPtu,
  Rs41Calibration,
  standardPressure,
  temperature,
  type Reading,
} from './ptu'
import { toFix } from './receiver'
import {
  K1930308_CALIBRATION,
  K1930308_FIRST_SUBFRAME,
  K1930308_FRAMES,
  L1830070_CALIBRATION,
  X4332388_CALIBRATION,
  X4332388_FRAMES,
} from './testdata'

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16))

function calibration(subframes: string[]) {
  const cal = new Rs41Calibration()
  subframes.forEach((hex, i) => cal.add(i, fromHex(hex)))
  return cal
}

const SONDES = { K1930308: K1930308_CALIBRATION, L1830070: L1830070_CALIBRATION, X4332388: X4332388_CALIBRATION }

// Expected values below come from rs41mod.c's get_T and get_RH2adv, ported line by
// line with float32 arithmetic and run on the same data (with humidity's pressure
// from Ph(), the standard atmosphere it uses when the sonde has no pressure sensor).

/** Real PTU counts from the recordings, with the GPS altitude of the same frame. */
const READINGS = [
  {
    sonde: 'K1930308',
    frame: 5096,
    alt: 28862.19,
    counts: [139843, 130599, 190182, 529213, 466358, 533219, 134133, 130598, 190182],
    temperature: -42.976265,
    sensorTemp: -37.737324,
    humidity: 0.417543,
  },
  {
    sonde: 'K1930308',
    frame: 5166,
    alt: 29346.52,
    counts: [141317, 130595, 190172, 529208, 466335, 533192, 135443, 130596, 190175],
    temperature: -40.675903,
    sensorTemp: -35.558910,
    humidity: 0.376255,
  },
  {
    sonde: 'L1830070',
    frame: 3222,
    alt: 14322.07,
    counts: [149839, 130526, 190224, 536072, 473669, 541203, 135156, 130528, 190225],
    temperature: -51.808449,
    sensorTemp: -46.527054,
    humidity: 1.106598,
  },
  {
    sonde: 'L1830070',
    frame: 3231,
    alt: 14373.3,
    counts: [150092, 130529, 190229, 536074, 473672, 541205, 135048, 130528, 190229],
    temperature: -51.468418,
    sensorTemp: -46.696648,
    humidity: 1.063932,
  },
] as const

describe('RS41 calibration', () => {
  it.each(Object.entries(SONDES))('%s: all 51 subframes match the checksum the sonde sends', (_, subframes) => {
    const cal = calibration(subframes)
    expect(cal.count).toBe(CALIBRATION_SUBFRAMES)
    expect(cal.checksumOk).toBe(true)
    cal.bytes[100] ^= 1
    expect(cal.checksumOk).toBe(false)
  })

  it.each(Object.entries(SONDES))('%s: coefficients land where rs41mod reads them', (_, subframes) => {
    const cal = calibration(subframes)
    // Nominal values rs41mod notes next to these fields.
    expect(cal.floats(61, 2)).toEqual([750, 1100])
    const [p0, p1, p2] = cal.floats(77, 3)!
    expect(p0).toBeCloseTo(-243.911, 3)
    expect(p1).toBeCloseTo(0.187654, 6)
    expect(p2).toBeCloseTo(8.2e-6, 9)
  })

  it('keeps the first copy of a subframe and ignores bad indices', () => {
    const cal = new Rs41Calibration()
    cal.add(3, fromHex(K1930308_CALIBRATION[3]))
    cal.add(3, new Uint8Array(16))
    cal.add(51, new Uint8Array(16).fill(1))
    expect(cal.count).toBe(1)
    expect(cal.bytes.subarray(48, 64)).toEqual(fromHex(K1930308_CALIBRATION[3]))
  })
})

describe('RS41 temperature and humidity', () => {
  it.each(READINGS)('$sonde #$frame', (r) => {
    const cal = calibration(SONDES[r.sonde])
    const counts = [...r.counts]
    expect(temperature(cal, counts.slice(6, 9) as Reading, HUMIDITY_SENSOR)).toBeCloseTo(r.sensorTemp, 3)
    const ptu = readPtu(cal, counts, r.alt)
    expect(ptu.temperature).toBeCloseTo(r.temperature, 3)
    expect(ptu.humidity).toBeCloseTo(r.humidity, 3)
  })

  // The recordings are all in very dry air, so these push the humidity polynomial across its range.
  it.each([
    ['K1930308', 535_500, 10, 12, 850, 49.161381],
    ['K1930308', 533_500, -20, -17, 400, 37.033337],
    ['K1930308', 538_000, 22, 24, 1000, 74.765518],
    ['L1830070', 535_500, 10, 12, 850, 59.480698],
    ['L1830070', 533_500, -20, -17, 400, 48.154930],
    ['L1830070', 538_000, 22, 24, 1000, 85.732391],
  ] as const)('%s: count %d at %d °C, sensor %d °C, %d hPa', (sonde, f, air, sensorTemp, pressure, rh) => {
    expect(humidity(calibration(SONDES[sonde]), [f, 466_357, 533_217], air, sensorTemp, pressure)).toBeCloseTo(rh, 3)
  })

  it('temperature waits for subframes 3-6 and humidity for 7-18 and 42-46', () => {
    const { counts, alt } = READINGS[0]
    const cal = new Rs41Calibration()
    const firstWith: { temperature?: number; humidity?: number } = {}
    for (let n = 0; n < CALIBRATION_SUBFRAMES; n++) {
      const index = (K1930308_FIRST_SUBFRAME + n) % CALIBRATION_SUBFRAMES
      cal.add(index, fromHex(K1930308_CALIBRATION[index]))
      const ptu = readPtu(cal, [...counts], alt)
      if (ptu.temperature !== undefined) firstWith.temperature ??= index
      if (ptu.humidity !== undefined) firstWith.humidity ??= index
    }
    // Received from 48 on: 48, 49, 50, 0, 1, …
    expect(firstWith).toEqual({ temperature: 6, humidity: 46 })
  })

  it('reads calibration and counts out of a real frame', () => {
    const data = decodeFrame(fromHex(K1930308_FRAMES[5096]), STANDARD_LENGTH)
    expect(data.serial).toBe('K1930308')
    expect(data.badBlocks).toBe(0)
    expect(data.calibration?.index).toBe(46)
    expect(data.calibration?.data).toEqual(fromHex(K1930308_CALIBRATION[46]))
    // An RS41-SG sends the pressure counts too, as zeros.
    expect(data.ptu).toEqual([...READINGS[0].counts, 0, 0, 0])

    const fix = toFix(data, 0, calibration(K1930308_CALIBRATION))!
    expect(fix.alt).toBeCloseTo(READINGS[0].alt, 0)
    expect(fix.temperature).toBeCloseTo(READINGS[0].temperature, 3)
    expect(fix.humidity).toBeCloseTo(READINGS[0].humidity, 3)
    expect(fix.pressure).toBeUndefined()
  })

  it('leaves both out without calibration', () => {
    const data = decodeFrame(fromHex(K1930308_FRAMES[5166]), STANDARD_LENGTH)
    const fix = toFix(data, 0, new Rs41Calibration())!
    expect(fix.temperature).toBeUndefined()
    expect(fix.humidity).toBeUndefined()
  })

  it('standard atmosphere is continuous across its layers', () => {
    expect(standardPressure(0)).toBeCloseTo(1013.25, 2)
    for (const [h, p] of [
      [11_000, 226.321],
      [20_000, 54.7489],
      [32_000, 8.6802],
    ]) {
      expect(standardPressure(h - 0.01)).toBeCloseTo(p, 1)
      expect(standardPressure(h + 0.01)).toBeCloseTo(p, 1)
    }
  })
})

// RS41-SGP X4332388 over its flight, with the pressure sensor's temperature. Expected values
// come from the same float32 port, now with get_P and humidity corrected by the measured
// pressure as rs41mod does; `sondehub` is what radiosonde_auto_rx stations (rs41mod) uploaded
// to SondeHub for the frame, rounded to 0.01 hPa.
const SGP_READINGS = [
  {
    frame: 1906,
    alt: 2217.33,
    counts: [167762, 127017, 184087, 555655, 484422, 552614, 171281, 127018, 184087, 328479, 293332, 416299],
    pressureTemp: 33.87,
    temperature: 5.869278,
    humidity: 87.913292,
    pressure: 784.657776,
    sondehub: 784.66,
  },
  {
    frame: 3004,
    alt: 8304.92,
    counts: [143260, 126831, 183941, 549838, 484589, 552869, 146808, 126831, 183942, 341186, 293352, 416423],
    pressureTemp: 15.62,
    temperature: -33.847023,
    humidity: 24.880318,
    pressure: 353.058655,
    sondehub: 353.06,
  },
  {
    frame: 3977,
    alt: 14560.24,
    counts: [131183, 126717, 183887, 548103, 485113, 553523, 134593, 126719, 183887, 353955, 293495, 416711],
    pressureTemp: -4.09,
    temperature: -53.15379,
    humidity: 1.448254,
    pressure: 135.869095,
    sondehub: 135.87,
  },
  {
    frame: 5325,
    alt: 22240.39,
    counts: [133366, 126700, 183885, 548409, 485350, 553806, 136538, 126701, 183884, 362744, 293577, 416852],
    pressureTemp: -11.45,
    temperature: -49.621941,
    humidity: 0.896492,
    pressure: 41.543789,
    sondehub: 41.54,
  },
  {
    frame: 6536,
    alt: 29967.33,
    counts: [139353, 126708, 183889, 548442, 485303, 553751, 142768, 126710, 183889, 366076, 293574, 416845],
    pressureTemp: -10.97,
    temperature: -39.992363,
    humidity: 0.489684,
    pressure: 12.879248,
    sondehub: 12.88,
  },
]

describe('RS41-SGP pressure', () => {
  it.each(SGP_READINGS)('X4332388 #$frame', (r) => {
    const ptu = readPtu(calibration(X4332388_CALIBRATION), r.counts, r.alt, r.pressureTemp)
    expect(ptu.pressure).toBeCloseTo(r.pressure, 3)
    expect(ptu.pressure).toBeCloseTo(r.sondehub, 2)
    expect(ptu.temperature).toBeCloseTo(r.temperature, 3)
    expect(ptu.humidity).toBeCloseTo(r.humidity, 3)
  })

  it('needs a sonde that says it has the sensor', () => {
    const { counts, alt, pressureTemp } = SGP_READINGS[1]
    // K1930308 is an RS41-SG: whatever sits where the coefficients would be, there is no sensor.
    expect(readPtu(calibration(K1930308_CALIBRATION), counts, alt, pressureTemp).pressure).toBeUndefined()
    expect(pressure(calibration(X4332388_CALIBRATION), [counts[9], counts[10], counts[11]], pressureTemp)).toBeDefined()
  })

  it('waits for subframe 33 (the sonde type) and 37-42 (the coefficients)', () => {
    const { counts, alt, pressureTemp } = SGP_READINGS[1]
    const cal = new Rs41Calibration()
    let first: number | undefined
    X4332388_CALIBRATION.forEach((hex, index) => {
      cal.add(index, fromHex(hex))
      if (readPtu(cal, counts, alt, pressureTemp).pressure !== undefined) first ??= index
    })
    expect(first).toBe(42)

    const withoutType = new Rs41Calibration()
    X4332388_CALIBRATION.forEach((hex, index) => {
      if (index !== 33) withoutType.add(index, fromHex(hex))
    })
    expect(readPtu(withoutType, counts, alt, pressureTemp).pressure).toBeUndefined()
  })

  it('reads all twelve counts and the sensor temperature out of a real frame', () => {
    const data = decodeFrame(fromHex(X4332388_FRAMES[3004]), STANDARD_LENGTH)
    expect(data.serial).toBe('X4332388')
    expect(data.badBlocks).toBe(0)
    expect(data.ptu).toEqual(SGP_READINGS[1].counts)
    expect(data.pressureTemp).toBe(SGP_READINGS[1].pressureTemp)

    const fix = toFix(data, 0, calibration(X4332388_CALIBRATION))!
    expect(fix.alt).toBeCloseTo(SGP_READINGS[1].alt, 1)
    expect(fix.pressure).toBeCloseTo(SGP_READINGS[1].pressure, 3)
    expect(fix.humidity).toBeCloseTo(SGP_READINGS[1].humidity, 3)
  })
})
