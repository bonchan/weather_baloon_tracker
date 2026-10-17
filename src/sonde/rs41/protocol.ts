// Vaisala RS41 framing, as reverse-engineered by zilog80 in rs1729/RS (demod/mod/rs41mod.c).

export const BAUD_RATE = 4800

/** Header bits in the order they go over the air (each byte LSB first, scrambled). */
export const HEADER_BITS = '0000100001101101010100111000100001000100011010010100100000011111'

/** The same header after descrambling, as it sits at the start of every frame. */
export const HEADER_BYTES = Uint8Array.of(0x86, 0x35, 0xf4, 0x40, 0x93, 0xdf, 0x1a, 0x60)

/** Whitening sequence; frame[i] = received[i] ^ MASK[i % 64]. */
export const MASK = Uint8Array.of(
  0x96, 0x83, 0x3e, 0x51, 0xb1, 0x49, 0x08, 0x98,
  0x32, 0x05, 0x59, 0x0e, 0xf9, 0x44, 0xc6, 0x26,
  0x21, 0x60, 0xc2, 0xea, 0x79, 0x5d, 0x6d, 0xa1,
  0x54, 0x69, 0x47, 0x0c, 0xdc, 0xe8, 0x5c, 0xf1,
  0xf7, 0x76, 0x82, 0x7f, 0x07, 0x99, 0xa2, 0x2c,
  0x93, 0x7c, 0x30, 0x63, 0xf5, 0x10, 0x2e, 0x61,
  0xd0, 0xbc, 0xb4, 0xb6, 0x06, 0xaa, 0xf4, 0x23,
  0x78, 0x6e, 0x3b, 0xae, 0xbf, 0x7b, 0x4c, 0xc1,
)

/** Standard frame; sondes with extra sensors (ozone etc.) send extended ones. */
export const STANDARD_LENGTH = 320
export const EXTENDED_LENGTH = 518

/** Reed-Solomon parity: two interleaved RS(255,231) codewords, 24 bytes each. */
export const PARITY_POS = 0x008
/** Frame type byte, 0x0F standard or 0xF0 extended; the RS message starts here. */
export const FRAME_TYPE_POS = 0x038
/** First block (0x79 status). Blocks are id, length, data, CRC16 (little endian). */
export const FIRST_BLOCK_POS = 0x039

export const BLOCK_STATUS = 0x79
export const BLOCK_PTU = 0x7a
/** RS41-SGM: temperature and humidity counts without the pressure ones. */
export const BLOCK_SGM_TU = 0x7f
export const BLOCK_GPS_POS = 0x7b
export const BLOCK_GPS_INFO = 0x7c
export const BLOCK_GPS_RAW = 0x7d
export const BLOCK_EMPTY = 0x76
/** RS41-SGM with encryption on: position is not readable. */
export const BLOCK_ENCRYPTED = 0x80
/** Newer firmware: ECEF position/velocity plus UTC date and time in one block. */
export const BLOCK_POS_DATETIME = 0x82

/** Frame length from the type byte, by majority of its nibble bits so a few bit errors don't matter. */
export function frameLength(typeByte: number): number {
  let votes = 0
  for (let i = 0; i < 4; i++) votes += ((typeByte >> i) & 1) - ((typeByte >> (i + 4)) & 1)
  return votes < 0 ? EXTENDED_LENGTH : STANDARD_LENGTH
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) over data[start, end). */
export function crc16(data: Uint8Array, start: number, end: number): number {
  let crc = 0xffff
  for (let i = start; i < end; i++) {
    crc ^= data[i] << 8
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc
}
