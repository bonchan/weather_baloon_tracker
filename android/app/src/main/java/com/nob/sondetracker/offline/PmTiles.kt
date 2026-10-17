package com.nob.sondetracker.offline

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.GZIPInputStream

/**
 * Reads single tiles out of a remote PMTiles v3 archive with HTTP range requests (spec:
 * github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md), so the phone can save just the
 * area it needs from the planet file. Tiles come back as stored (gzip-compressed vector
 * tiles), which is what MBTiles keeps and MapLibre reads.
 */
class PmTiles(
    private val url: String,
    /** (offset, length) -> bytes; swappable for tests. */
    private val fetch: (Long, Int) -> ByteArray = { offset, length -> httpRange(url, offset, length) },
) {
    data class Header(
        val rootOffset: Long,
        val rootLength: Int,
        val leafOffset: Long,
        val tileDataOffset: Long,
        val internalCompression: Int,
        val maxZoom: Int,
    )

    data class Entry(val tileId: Long, val offset: Long, val length: Int, val runLength: Int)

    private var header: Header? = null
    private var root: List<Entry>? = null
    private val leaves = object : LinkedHashMap<Long, List<Entry>>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Long, List<Entry>>?) = size > MAX_LEAVES
    }

    @Synchronized
    private fun open(): Pair<Header, List<Entry>> {
        val h = header
        val r = root
        if (h != null && r != null) return h to r
        // The spec keeps the header and the root directory within the first 16 KiB.
        val start = fetch(0, 16_384)
        val parsed = parseHeader(start)
        val rootBytes = if (parsed.rootOffset + parsed.rootLength <= start.size) {
            start.copyOfRange(parsed.rootOffset.toInt(), (parsed.rootOffset + parsed.rootLength).toInt())
        } else {
            fetch(parsed.rootOffset, parsed.rootLength)
        }
        val entries = parseDirectory(decompress(rootBytes, parsed.internalCompression))
        header = parsed
        root = entries
        return parsed to entries
    }

    private fun leaf(h: Header, offset: Long, length: Int): List<Entry> {
        synchronized(leaves) { leaves[offset]?.let { return it } }
        val entries = parseDirectory(decompress(fetch(h.leafOffset + offset, length), h.internalCompression))
        synchronized(leaves) { leaves[offset] = entries }
        return entries
    }

    /** The tile's bytes, or null when the archive has no such tile. */
    fun getTile(z: Int, x: Int, y: Int): ByteArray? {
        val (h, rootDir) = open()
        if (z > h.maxZoom) return null
        val id = zxyToTileId(z, x.toLong(), y.toLong())
        var dir = rootDir
        repeat(MAX_DEPTH) {
            val entry = findTile(dir, id) ?: return null
            if (entry.runLength > 0) return fetch(h.tileDataOffset + entry.offset, entry.length)
            dir = leaf(h, entry.offset, entry.length)
        }
        return null
    }

    companion object {
        private const val MAX_DEPTH = 4
        private const val MAX_LEAVES = 64
        private const val COMPRESSION_NONE = 1
        private const val COMPRESSION_GZIP = 2

        /** Hilbert-curve tile id: all tiles of lower zooms first, then this zoom along the curve. */
        fun zxyToTileId(z: Int, x: Long, y: Long): Long {
            var acc = 0L
            for (t in 0 until z) acc += 1L shl (2 * t)
            val n = 1L shl z
            var xx = x
            var yy = y
            var d = 0L
            var s = n / 2
            while (s > 0) {
                val rx = if ((xx and s) > 0) 1L else 0L
                val ry = if ((yy and s) > 0) 1L else 0L
                d += s * s * ((3 * rx) xor ry)
                // rotate
                if (ry == 0L) {
                    if (rx == 1L) {
                        xx = s - 1 - xx
                        yy = s - 1 - yy
                    }
                    val t = xx
                    xx = yy
                    yy = t
                }
                s /= 2
            }
            return acc + d
        }

        fun parseHeader(b: ByteArray): Header {
            if (b.size < 127 || String(b, 0, 7, Charsets.US_ASCII) != "PMTiles" || b[7].toInt() != 3) {
                throw IOException("Not a PMTiles v3 archive")
            }
            val buf = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN)
            return Header(
                rootOffset = buf.getLong(8),
                rootLength = buf.getLong(16).toInt(),
                leafOffset = buf.getLong(40),
                tileDataOffset = buf.getLong(56),
                internalCompression = b[97].toInt(),
                maxZoom = b[101].toInt() and 0xFF,
            )
        }

        /** Varint-coded columns: ids (delta), run lengths, lengths, offsets (0 = right after the previous). */
        fun parseDirectory(b: ByteArray): List<Entry> {
            var pos = 0
            fun varint(): Long {
                var result = 0L
                var shift = 0
                while (true) {
                    val byte = b[pos++].toInt() and 0xFF
                    result = result or ((byte and 0x7F).toLong() shl shift)
                    if (byte and 0x80 == 0) return result
                    shift += 7
                }
            }
            val n = varint().toInt()
            val ids = LongArray(n)
            var last = 0L
            for (i in 0 until n) {
                last += varint()
                ids[i] = last
            }
            val runs = IntArray(n) { varint().toInt() }
            val lengths = IntArray(n) { varint().toInt() }
            val offsets = LongArray(n)
            for (i in 0 until n) {
                val v = varint()
                offsets[i] = if (v == 0L && i > 0) offsets[i - 1] + lengths[i - 1] else v - 1
            }
            return List(n) { Entry(ids[it], offsets[it], lengths[it], runs[it]) }
        }

        /** The entry holding tileId: an exact or run-length match, or a leaf directory to descend into. */
        fun findTile(entries: List<Entry>, tileId: Long): Entry? {
            var lo = 0
            var hi = entries.size - 1
            while (lo <= hi) {
                val mid = (lo + hi) ushr 1
                val cmp = tileId.compareTo(entries[mid].tileId)
                when {
                    cmp > 0 -> lo = mid + 1
                    cmp < 0 -> hi = mid - 1
                    else -> return entries[mid]
                }
            }
            if (hi >= 0) {
                val e = entries[hi]
                if (e.runLength == 0) return e
                if (tileId - e.tileId < e.runLength) return e
            }
            return null
        }

        fun decompress(b: ByteArray, compression: Int): ByteArray = when (compression) {
            COMPRESSION_NONE -> b
            COMPRESSION_GZIP -> GZIPInputStream(b.inputStream()).use { it.readBytes() }
            else -> throw IOException("PMTiles compression $compression not supported")
        }

        fun httpRange(url: String, offset: Long, length: Int): ByteArray {
            val c = URL(url).openConnection() as HttpURLConnection
            c.connectTimeout = 15_000
            c.readTimeout = 30_000
            c.setRequestProperty("Range", "bytes=$offset-${offset + length - 1}")
            try {
                // Anything but 206 would be the whole 130 GB planet file.
                if (c.responseCode != 206) throw IOException("HTTP ${c.responseCode} for a range request")
                val out = ByteArrayOutputStream(length)
                c.inputStream.use { it.copyTo(out) }
                return out.toByteArray()
            } finally {
                c.disconnect()
            }
        }
    }
}
