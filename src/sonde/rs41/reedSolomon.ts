// RS(255,231) over GF(2^8) with field polynomial 0x11D and generator roots α^0..α^23,
// the code the RS41 uses (rs1729 bch_ecc_mod.c: rs_init_RS255). Codeword index i is the
// coefficient of x^i: parity in [0, 24), message in [24, 255).

export const RS_N = 255
export const RS_PARITY = 24
export const RS_K = RS_N - RS_PARITY

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}

const mul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0)
const div = (a: number, b: number) => (a ? EXP[LOG[a] + 255 - LOG[b]] : 0)
/** α^-i */
const invPow = (i: number) => EXP[(255 - (i % 255)) % 255]

/** g(x) = (x - α^0)(x - α^1)…(x - α^23), lowest power first. */
const GENERATOR = (() => {
  let g = [1]
  for (let i = 0; i < RS_PARITY; i++) {
    const next = new Array<number>(g.length + 1).fill(0)
    for (let j = 0; j < g.length; j++) {
      next[j + 1] ^= g[j]
      next[j] ^= mul(g[j], EXP[i])
    }
    g = next
  }
  return Uint8Array.from(g)
})()

/** Fills cw[0, 24) with the parity for the message in cw[24, 255). */
export function rsEncode(cw: Uint8Array) {
  const rem = Uint8Array.from(cw)
  rem.fill(0, 0, RS_PARITY)
  for (let i = RS_N - 1; i >= RS_PARITY; i--) {
    const coef = rem[i]
    if (!coef) continue
    for (let j = 0; j <= RS_PARITY; j++) rem[i - RS_PARITY + j] ^= mul(coef, GENERATOR[j])
  }
  cw.set(rem.subarray(0, RS_PARITY))
}

function evaluate(poly: ArrayLike<number>, x: number): number {
  let v = 0
  for (let k = poly.length - 1; k >= 0; k--) v = mul(v, x) ^ poly[k]
  return v
}

/**
 * Corrects up to 12 wrong bytes in place (Berlekamp-Massey, Chien search, Forney).
 * Returns the number corrected, or -1 if the codeword is beyond repair.
 */
export function rsDecode(cw: Uint8Array): number {
  const syndromes = new Uint8Array(RS_PARITY)
  let any = 0
  for (let j = 0; j < RS_PARITY; j++) {
    syndromes[j] = evaluate(cw, EXP[j])
    any |= syndromes[j]
  }
  if (!any) return 0

  // Error locator Λ(x), lowest power first.
  let locator = [1]
  let prev = [1]
  let degree = 0
  let shift = 1
  let lastDiscrepancy = 1
  for (let n = 0; n < RS_PARITY; n++) {
    let d = syndromes[n]
    for (let i = 1; i <= degree; i++) d ^= mul(locator[i] ?? 0, syndromes[n - i])
    if (d === 0) {
      shift++
      continue
    }
    const before = locator.slice()
    const coef = div(d, lastDiscrepancy)
    while (locator.length < prev.length + shift) locator.push(0)
    for (let i = 0; i < prev.length; i++) locator[i + shift] ^= mul(coef, prev[i])
    if (2 * degree <= n) {
      degree = n + 1 - degree
      prev = before
      lastDiscrepancy = d
      shift = 1
    } else {
      shift++
    }
  }
  if (degree > RS_PARITY / 2) return -1
  locator = locator.slice(0, degree + 1)

  const positions: number[] = []
  for (let i = 0; i < RS_N; i++) if (evaluate(locator, invPow(i)) === 0) positions.push(i)
  if (positions.length !== degree) return -1

  // Error evaluator Ω(x) = S(x)Λ(x) mod x^24.
  const omega = new Uint8Array(RS_PARITY)
  for (let i = 0; i < RS_PARITY; i++) {
    let v = 0
    for (let k = 0; k <= Math.min(i, degree); k++) v ^= mul(locator[k], syndromes[i - k])
    omega[i] = v
  }
  // Formal derivative: in GF(2^m) only the odd powers survive.
  const derivative = locator.map((c, k) => (k % 2 === 1 ? c : 0)).slice(1)

  for (const i of positions) {
    const xInv = invPow(i)
    const denominator = evaluate(derivative, xInv)
    if (!denominator) return -1
    // Forney with first root α^0: e = X·Ω(X⁻¹)/Λ'(X⁻¹).
    cw[i] ^= mul(EXP[i], div(evaluate(omega, xInv), denominator))
  }
  return positions.length
}
