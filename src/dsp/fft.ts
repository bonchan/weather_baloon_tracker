/** In-place iterative radix-2 complex FFT. */
export class FFT {
  readonly size: number
  private reverse: Uint32Array
  private cos: Float64Array
  private sin: Float64Array

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error(`FFT size must be a power of two, got ${size}`)
    this.size = size
    const bits = Math.log2(size)
    this.reverse = new Uint32Array(size)
    for (let i = 0; i < size; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.reverse[i] = r
    }
    this.cos = new Float64Array(size / 2)
    this.sin = new Float64Array(size / 2)
    for (let i = 0; i < size / 2; i++) {
      const angle = (-2 * Math.PI * i) / size
      this.cos[i] = Math.cos(angle)
      this.sin[i] = Math.sin(angle)
    }
  }

  /** Forward transform of (re, im), overwriting both. */
  transform(re: Float64Array, im: Float64Array) {
    const n = this.size
    const reverse = this.reverse
    for (let i = 0; i < n; i++) {
      const j = reverse[i]
      if (j > i) {
        const tr = re[i]
        re[i] = re[j]
        re[j] = tr
        const ti = im[i]
        im[i] = im[j]
        im[j] = ti
      }
    }
    const cos = this.cos
    const sin = this.sin
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1
      const step = n / len
      for (let start = 0; start < n; start += len) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step]
          const wi = sin[k * step]
          const a = start + k
          const b = a + half
          const xr = re[b] * wr - im[b] * wi
          const xi = re[b] * wi + im[b] * wr
          re[b] = re[a] - xr
          im[b] = im[a] - xi
          re[a] += xr
          im[a] += xi
        }
      }
    }
  }
}
