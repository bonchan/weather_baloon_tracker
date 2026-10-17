package com.nob.sondetracker.offline

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TileMathTest {
    private val world = Bounds(-180.0, -85.0, 179.999, 85.0)

    @Test
    fun countsTheWholeWorld() {
        assertEquals(1L + 4 + 16, TileMath.count(world, 2))
    }

    @Test
    fun enumeratesWhatItCounts() {
        val area = TileMath.boundsAround(-38.95, -68.06, 100.0)
        assertEquals(TileMath.count(area, 9), TileMath.tilesIn(area, 9).count().toLong())
    }

    @Test
    fun keepsAround200KmAtZoom12ToAFewThousandTiles() {
        val n = TileMath.count(TileMath.boundsAround(-38.95, -68.06, 200.0), 12)
        assertTrue(n in 2_000..8_000)
    }

    @Test
    fun putsNeuquenInTheSouthWesternQuadrant() {
        assertEquals(0, TileMath.tileX(-68.06, 1))
        assertEquals(1, TileMath.tileY(-38.95, 1))
    }

    @Test
    fun matchesTheWebAppForAKnownTile() {
        // Same formula as webapp/src/map/tileMath.ts.
        assertEquals(1273, TileMath.tileX(-68.06, 12))
        assertEquals(2529, TileMath.tileY(-38.95, 12))
    }
}
