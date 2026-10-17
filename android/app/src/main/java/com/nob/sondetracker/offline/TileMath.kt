package com.nob.sondetracker.offline

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.tan

/** Slippy-map tile arithmetic for downloading areas (same as the web app's tileMath.ts). */
data class Bounds(val west: Double, val south: Double, val east: Double, val north: Double)

data class TileId(val z: Int, val x: Int, val y: Int)

object TileMath {
    private const val MAX_LAT = 85.0511
    private const val EARTH_RADIUS = 6_371_008.8

    fun tileX(lon: Double, z: Int): Int = clamp(floor((lon + 180) / 360 * (1 shl z)).toInt(), z)

    fun tileY(lat: Double, z: Int): Int {
        val r = Math.toRadians(lat.coerceIn(-MAX_LAT, MAX_LAT))
        return clamp(floor((1 - ln(tan(r) + 1 / cos(r)) / PI) / 2 * (1 shl z)).toInt(), z)
    }

    private fun clamp(v: Int, z: Int) = v.coerceIn(0, (1 shl z) - 1)

    fun count(b: Bounds, maxZoom: Int): Long {
        var total = 0L
        for (z in 0..maxZoom) {
            total += (tileX(b.east, z) - tileX(b.west, z) + 1).toLong() * (tileY(b.south, z) - tileY(b.north, z) + 1)
        }
        return total
    }

    fun tilesIn(b: Bounds, maxZoom: Int): Sequence<TileId> = sequence {
        for (z in 0..maxZoom) {
            for (x in tileX(b.west, z)..tileX(b.east, z)) {
                for (y in tileY(b.north, z)..tileY(b.south, z)) yield(TileId(z, x, y))
            }
        }
    }

    fun boundsAround(lat: Double, lon: Double, radiusKm: Double): Bounds {
        val r = radiusKm * 1000
        val dLat = Math.toDegrees(r / EARTH_RADIUS)
        val dLon = Math.toDegrees(r / (EARTH_RADIUS * cos(Math.toRadians(lat))))
        return Bounds(lon - dLon, lat - dLat, lon + dLon, lat + dLat)
    }
}
