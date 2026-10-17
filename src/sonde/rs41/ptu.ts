// Temperature and humidity from the RS41 PTU block. The formulas are rs1729's
// get_T and get_RH2adv (the latter after DF9DQ) in demod/mod/rs41mod.c, which is
// what radiosonde_auto_rx runs (--ptu2) and so what SondeHub shows.
import { crc16 } from './protocol'

/** Each frame carries one 16-byte piece of the sonde's calibration, numbered 0..50. */
export const CALIBRATION_SUBFRAMES = 51
const SUBFRAME_LENGTH = 16

// Float32 coefficients by byte offset in the assembled calibration (rs41mod's get_CalData).
/** Reference resistors the temperature counts are measured against, ~750 and ~1100 Ω. */
const REF_RESISTORS = 61
/** Reference capacitances for the humidity sensor, pF. */
const REF_CAPACITORS = 69
const HUMIDITY_CAL = 117
/** 7×6 polynomial in sensor capacitance × sensor temperature. */
const HUMIDITY_MATRIX = 125
const HUMIDITY_PRESSURE_COR = 678
const HUMIDITY_TEMPERATURE_COR = 698

/** Resistance-to-temperature polynomial and per-sensor correction. */
type TemperatureSensor = { poly: number; cal: number }
const AIR_SENSOR: TemperatureSensor = { poly: 77, cal: 89 }
/** The humidity sensor is heated, so it has its own thermometer. */
export const HUMIDITY_SENSOR: TemperatureSensor = { poly: 293, cal: 305 }

/** One sonde's calibration, collected as the subframes come in. */
export class Rs41Calibration {
  readonly bytes = new Uint8Array(CALIBRATION_SUBFRAMES * SUBFRAME_LENGTH)
  private readonly view = new DataView(this.bytes.buffer)
  private readonly have = new Uint8Array(CALIBRATION_SUBFRAMES)
  count = 0

  add(index: number, data: Uint8Array) {
    if (index >= CALIBRATION_SUBFRAMES || this.have[index]) return
    this.bytes.set(data.subarray(0, SUBFRAME_LENGTH), index * SUBFRAME_LENGTH)
    this.have[index] = 1
    this.count++
  }

  get complete() {
    return this.count === CALIBRATION_SUBFRAMES
  }

  /** Subframe 0 starts with a CRC of the rest; the last subframe varies and is not covered. */
  get checksumOk() {
    const end = (CALIBRATION_SUBFRAMES - 1) * SUBFRAME_LENGTH
    return this.complete && crc16(this.bytes, 2, end) === (this.bytes[0] | (this.bytes[1] << 8))
  }

  /** `count` float32s at `offset`, or null until every subframe they span has arrived. */
  floats(offset: number, count: number): number[] | null {
    for (let s = offset >> 4; s <= (offset + 4 * count - 1) >> 4; s++) if (!this.have[s]) return null
    return Array.from({ length: count }, (_, i) => this.view.getFloat32(offset + 4 * i, true))
  }
}

/** A measurement count and the counts of its two references, as the PTU block sends them. */
export type Reading = [f: number, ref1: number, ref2: number]

/** Platinum resistor temperature, °C. */
export function temperature(cal: Rs41Calibration, [f, f1, f2]: Reading, sensor = AIR_SENSOR): number | undefined {
  const ref = cal.floats(REF_RESISTORS, 2)
  const p = cal.floats(sensor.poly, 3)
  const c = cal.floats(sensor.cal, 3)
  if (!ref || !p || !c || f1 === f2) return undefined
  // The counts are linear in resistance; the two references give the gain and offset.
  const gain = (f2 - f1) / (ref[1] - ref[0])
  const offset = (f1 * ref[1] - f2 * ref[0]) / (f2 - f1)
  const r = (f / gain - offset) * c[0]
  return (p[0] + p[1] * r + p[2] * r * r + c[1]) * (1 + c[2])
}

/** Saturation vapor pressure over water (Hyland and Wexler), Pa. */
function saturationPressure(celsius: number) {
  const t = celsius + 273.15
  return Math.exp(
    -5800.2206 / t + 1.3914993 + 6.5459673 * Math.log(t) - 4.8640239e-2 * t + 4.1764768e-5 * t * t - 1.4452093e-8 * t * t * t,
  )
}

/**
 * Relative humidity, %, from the capacitive sensor. `sensorTemp` is the heated
 * sensor's own temperature, `air` the air temperature, `pressure` in hPa.
 */
export function humidity(
  cal: Rs41Calibration,
  [f, f1, f2]: Reading,
  air: number,
  sensorTemp: number,
  pressure: number,
): number | undefined {
  const refC = cal.floats(REF_CAPACITORS, 2)
  const calH = cal.floats(HUMIDITY_CAL, 2)
  const matrix = cal.floats(HUMIDITY_MATRIX, 42)
  const corP = cal.floats(HUMIDITY_PRESSURE_COR, 3)
  const corT = cal.floats(HUMIDITY_TEMPERATURE_COR, 12)
  if (!refC || !calH || !matrix || !corP || !corT || f1 === f2) return undefined

  const capacitance = refC[0] + ((refC[1] - refC[0]) * (f - f1)) / (f2 - f1)
  let cp = (capacitance / calH[0] - 1) * calH[1]
  const tp = (sensorTemp - 20) / 180
  const tPow = [1, tp, tp ** 2, tp ** 3, tp ** 4, tp ** 5]

  // The capacitance also shifts a little with pressure.
  const bar = pressure / 1000
  let correction = 0
  for (let j = 0; j < 3; j++) {
    const bp = corP[j] * (bar / (1 + corP[j] * bar) - cp ** j / (1 + corP[j]))
    let bt = 0
    for (let k = 0; k < 4; k++) bt += corT[4 * j + k] * tPow[k]
    correction += bp * bt
  }
  cp -= correction

  let rh = 0
  for (let j = 0; j < 7; j++) for (let k = 0; k < 6; k++) rh += cp ** j * tPow[k] * matrix[6 * j + k]
  // That is humidity at the sensor's temperature; the air around it is colder.
  rh *= saturationPressure(sensorTemp) / saturationPressure(air)
  return Math.max(0, Math.min(100, rh))
}

/** Standard atmosphere pressure at a height, hPa. Stands in for a pressure sensor, which most RS41s lack. */
export function standardPressure(alt: number) {
  const gMR = (9.80665 * 0.0289644) / 8.31446
  const [pb, tb, lb, hb] =
    alt > 32_000
      ? [8.6802, 228.65, 0.0028, 32_000]
      : alt > 20_000
        ? [54.7489, 216.65, 0.001, 20_000]
        : alt > 11_000
          ? [226.321, 216.65, 0, 11_000]
          : [1013.25, 288.15, -0.0065, 0]
  return lb === 0 ? pb * Math.exp((-gMR * (alt - hb)) / tb) : pb * (1 + (lb * (alt - hb)) / tb) ** (-gMR / lb)
}

/**
 * Air temperature (°C) and relative humidity (%) from the PTU block's counts:
 * air thermometer, humidity sensor, humidity sensor thermometer, three each.
 * Either is missing until the calibration parts it needs have arrived.
 */
export function readPtu(cal: Rs41Calibration, counts: number[], alt: number) {
  const reading = (i: number): Reading => [counts[i], counts[i + 1], counts[i + 2]]
  const finite = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? v : undefined)
  const air = finite(temperature(cal, reading(0)))
  const sensorTemp = finite(temperature(cal, reading(6), HUMIDITY_SENSOR))
  const rh =
    air !== undefined && sensorTemp !== undefined
      ? finite(humidity(cal, reading(3), air, sensorTemp, standardPressure(alt)))
      : undefined
  return { temperature: air, humidity: rh }
}
