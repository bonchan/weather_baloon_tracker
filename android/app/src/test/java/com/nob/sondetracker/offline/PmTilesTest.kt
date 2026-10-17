package com.nob.sondetracker.offline

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

class PmTilesTest {
    @Test
    fun tileIdsFollowTheSpec() {
        // Values from the PMTiles v3 spec.
        assertEquals(0L, PmTiles.zxyToTileId(0, 0, 0))
        assertEquals(1L, PmTiles.zxyToTileId(1, 0, 0))
        assertEquals(2L, PmTiles.zxyToTileId(1, 0, 1))
        assertEquals(3L, PmTiles.zxyToTileId(1, 1, 1))
        assertEquals(4L, PmTiles.zxyToTileId(1, 1, 0))
        assertEquals(5L, PmTiles.zxyToTileId(2, 0, 0))
        assertEquals(19_078_479L, PmTiles.zxyToTileId(12, 3423, 1763))
    }

    private fun varint(out: ByteArrayOutputStream, value: Long) {
        var v = value
        while (v >= 0x80) {
            out.write(((v and 0x7F) or 0x80).toInt())
            v = v ushr 7
        }
        out.write(v.toInt())
    }

    /** The spec's directory encoding, to build test archives. */
    private fun directory(entries: List<PmTiles.Entry>): ByteArray {
        val out = ByteArrayOutputStream()
        varint(out, entries.size.toLong())
        var last = 0L
        for (e in entries) {
            varint(out, e.tileId - last)
            last = e.tileId
        }
        entries.forEach { varint(out, it.runLength.toLong()) }
        entries.forEach { varint(out, it.length.toLong()) }
        entries.forEachIndexed { i, e ->
            val prev = entries.getOrNull(i - 1)
            varint(out, if (i > 0 && prev != null && e.offset == prev.offset + prev.length) 0 else e.offset + 1)
        }
        return out.toByteArray()
    }

    @Test
    fun directoryRoundTrips() {
        val entries = listOf(
            PmTiles.Entry(tileId = 0, offset = 0, length = 10, runLength = 1),
            PmTiles.Entry(tileId = 1, offset = 10, length = 20, runLength = 3),
            PmTiles.Entry(tileId = 300, offset = 500, length = 7, runLength = 0),
        )
        assertEquals(entries, PmTiles.parseDirectory(directory(entries)))
    }

    @Test
    fun findsExactRunAndLeafEntries() {
        val entries = listOf(
            PmTiles.Entry(0, 0, 10, 1),
            PmTiles.Entry(5, 10, 10, 4), // tiles 5..8 share these bytes
            PmTiles.Entry(100, 0, 50, 0), // leaf directory for 100 and beyond
        )
        assertEquals(entries[0], PmTiles.findTile(entries, 0))
        assertNull(PmTiles.findTile(entries, 3))
        assertEquals(entries[1], PmTiles.findTile(entries, 7))
        assertNull(PmTiles.findTile(entries, 9))
        assertEquals(entries[2], PmTiles.findTile(entries, 1234))
    }

    @Test
    fun readsATileFromAnArchive() {
        val tile = "vector tile bytes".toByteArray()
        val tileId = PmTiles.zxyToTileId(3, 2, 5)
        val root = directory(listOf(PmTiles.Entry(tileId, 0, tile.size, 1)))
        val header = ByteBuffer.allocate(127).order(ByteOrder.LITTLE_ENDIAN).apply {
            put("PMTiles".toByteArray())
            put(3) // version
            putLong(8, 127) // root offset
            putLong(16, root.size.toLong()) // root length
            putLong(40, 0) // leaf directories (none)
            putLong(56, 127L + root.size) // tile data
            put(97, 1) // internal compression: none
            put(101, 14) // max zoom
        }.array()
        val archive = header + root + tile
        val pm = PmTiles("test://") { offset, length ->
            archive.copyOfRange(offset.toInt(), minOf(archive.size, (offset + length).toInt()))
        }
        assertArrayEquals(tile, pm.getTile(3, 2, 5))
        assertNull(pm.getTile(3, 2, 6))
        assertNull(pm.getTile(15, 0, 0))
    }
}
