package com.nob.sondetracker.offline

import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import java.io.File

/**
 * Tiles kept on the phone in an MBTiles file (SQLite), which MapLibre reads directly through an
 * "mbtiles://" source. Rows are TMS: y counts from the bottom.
 */
class MbTiles(val file: File, format: String) {
    private val db: SQLiteDatabase

    init {
        file.parentFile?.mkdirs()
        db = SQLiteDatabase.openOrCreateDatabase(file, null)
        // MapLibre reads while we write.
        db.enableWriteAheadLogging()
        db.execSQL("CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT)")
        db.execSQL("CREATE TABLE IF NOT EXISTS tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)")
        db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS tile_index ON tiles (zoom_level, tile_column, tile_row)")
        setMeta("name", file.nameWithoutExtension)
        setMeta("format", format)
        setMeta("minzoom", "0")
        if (getMeta("maxzoom") == null) setMeta("maxzoom", "0")
    }

    private fun row(z: Int, y: Int) = (1 shl z) - 1 - y

    fun has(z: Int, x: Int, y: Int): Boolean =
        db.rawQuery(
            "SELECT 1 FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ? LIMIT 1",
            arrayOf(z.toString(), x.toString(), row(z, y).toString()),
        ).use { it.moveToFirst() }

    fun put(z: Int, x: Int, y: Int, data: ByteArray) {
        val values = ContentValues().apply {
            put("zoom_level", z)
            put("tile_column", x)
            put("tile_row", row(z, y))
            put("tile_data", data)
        }
        db.insertWithOnConflict("tiles", null, values, SQLiteDatabase.CONFLICT_REPLACE)
    }

    /** Highest zoom saved; MapLibre stretches those tiles when zooming in further. */
    fun maxZoom(): Int = getMeta("maxzoom")?.toIntOrNull() ?: 0

    fun raiseMaxZoom(z: Int) {
        if (z > maxZoom()) setMeta("maxzoom", z.toString())
    }

    fun isEmpty(): Boolean = db.rawQuery("SELECT 1 FROM tiles LIMIT 1", null).use { !it.moveToFirst() }

    fun clear() {
        db.execSQL("DELETE FROM tiles")
        setMeta("maxzoom", "0")
        db.execSQL("VACUUM")
    }

    fun sizeBytes(): Long = listOf(file, File(file.path + "-wal")).sumOf { if (it.exists()) it.length() else 0L }

    val url: String get() = "mbtiles://${file.absolutePath}"

    private fun getMeta(name: String): String? =
        db.rawQuery("SELECT value FROM metadata WHERE name = ?", arrayOf(name)).use { if (it.moveToFirst()) it.getString(0) else null }

    private fun setMeta(name: String, value: String) {
        db.insertWithOnConflict("metadata", null, ContentValues().apply {
            put("name", name)
            put("value", value)
        }, SQLiteDatabase.CONFLICT_REPLACE)
    }
}
