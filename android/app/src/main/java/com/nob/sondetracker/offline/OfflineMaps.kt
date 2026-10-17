package com.nob.sondetracker.offline

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.min

/**
 * The map on the phone: every user downloads the areas they need, and the map then works with
 * no internet. Each download saves the vector map (from the same Protomaps planet file as the
 * web app) and the satellite imagery (Sentinel-2 cloudless by EOX) into two MBTiles files.
 */
object OfflineMaps {
    private const val PLANET_URL = "https://data.source.coop/protomaps/openstreetmap/v4.pmtiles"
    /** Sentinel-2 cloudless (s2maps.eu), CC BY-NC-SA 4.0: fine to keep offline for non-commercial use. */
    private const val SATELLITE_URL = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/%d/%d/%d.jpg"
    private const val SATELLITE_ATTRIBUTION = "Sentinel-2 cloudless by EOX (Copernicus Sentinel data 2023)"
    /** 10 m imagery holds no more detail past this; MapLibre stretches it above. */
    const val SATELLITE_MAX_ZOOM = 14
    /** Above this the download would take hours and hundreds of MB. */
    const val MAX_DOWNLOAD_TILES = 60_000L
    const val SATELLITE_LAYER = "satellite"
    private const val WORKERS = 6

    data class Progress(val done: Int, val total: Int, val bytes: Long, val failed: Int, val running: Boolean)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var appContext: Context
    lateinit var map: MbTiles
        private set
    lateinit var satellite: MbTiles
        private set
    private val planet = PmTiles(PLANET_URL)
    private lateinit var prefs: android.content.SharedPreferences
    private var job: Job? = null

    private val _progress = MutableStateFlow<Progress?>(null)
    val progress: StateFlow<Progress?> = _progress
    /** Bumped when new tiles were saved, so the map reloads them. */
    private val _version = MutableStateFlow(0)
    val version: StateFlow<Int> = _version

    fun init(context: Context) {
        if (::map.isInitialized) return
        appContext = context.applicationContext
        prefs = appContext.getSharedPreferences("maps", Context.MODE_PRIVATE)
        val dir = File(appContext.filesDir, "maps")
        map = MbTiles(File(dir, "basemap.mbtiles"), "pbf")
        satellite = MbTiles(File(dir, "satellite.mbtiles"), "jpg")
    }

    /** Satellite imagery instead of the vector map; remembered across launches. */
    var satelliteView: Boolean
        get() = prefs.getBoolean("satellite", false)
        set(value) = prefs.edit().putBoolean("satellite", value).apply()

    /** Map layers that hide under the satellite imagery: all but the background and the labels. */
    val baseLayers: List<String> by lazy {
        val layers = JSONObject(appContext.assets.open("map/style-dark-es.json").bufferedReader().readText()).getJSONArray("layers")
        (0 until layers.length()).map { layers.getJSONObject(it) }
            .filter { it.getString("type") != "background" && it.getString("id") !in labelLayers }
            .map { it.getString("id") }
    }

    /** Label layers stay on top of the satellite imagery; the rest of the map hides under it. */
    val labelLayers: Set<String> by lazy {
        val json = JSONArray(appContext.assets.open("map/label-layers.json").bufferedReader().readText())
        (0 until json.length()).map { json.getString(it) }.toSet()
    }

    /** The bundled style, pointed at the tiles on the phone. */
    fun styleJson(lang: String, showSatellite: Boolean): String {
        val style = JSONObject(appContext.assets.open("map/style-dark-$lang.json").bufferedReader().readText())
        val sources = style.getJSONObject("sources")
        sources.put("protomaps", JSONObject().put("type", "vector").put("url", map.url).put("attribution", "© OpenStreetMap · Protomaps"))
        sources.put(
            "satellite",
            JSONObject().put("type", "raster").put("url", satellite.url).put("tileSize", 256).put("attribution", SATELLITE_ATTRIBUTION),
        )
        val layers = style.getJSONArray("layers")
        val out = JSONArray()
        for (i in 0 until layers.length()) {
            val layer = layers.getJSONObject(i)
            val id = layer.getString("id")
            val type = layer.getString("type")
            if (showSatellite && type != "background" && id !in labelLayers) {
                layer.put("layout", (layer.optJSONObject("layout") ?: JSONObject()).put("visibility", "none"))
            }
            out.put(layer)
            // The imagery sits right above the background, under everything else.
            if (type == "background") {
                out.put(
                    JSONObject().put("id", SATELLITE_LAYER).put("type", "raster").put("source", "satellite")
                        .put("layout", JSONObject().put("visibility", if (showSatellite) "visible" else "none")),
                )
            }
        }
        style.put("layers", out)
        return style.toString()
    }

    /** Whether the map around this point is saved, at the zoom the user is looking at. */
    fun covered(lat: Double, lon: Double, zoom: Double): Boolean {
        if (map.isEmpty()) return false
        val z = min(zoom.toInt(), map.maxZoom())
        return map.has(z, TileMath.tileX(lon, z), TileMath.tileY(lat, z))
    }

    fun estimate(bounds: Bounds, maxZoom: Int): Long =
        TileMath.count(bounds, maxZoom) + TileMath.count(bounds, min(maxZoom, SATELLITE_MAX_ZOOM))

    fun storageBytes(): Long = map.sizeBytes() + satellite.sizeBytes()

    fun cancel() {
        job?.cancel()
    }

    fun deleteAll() {
        cancel()
        scope.launch {
            map.clear()
            satellite.clear()
            _version.value++
        }
    }

    private sealed interface Work {
        val tile: TileId
        data class MapTile(override val tile: TileId) : Work
        data class SatTile(override val tile: TileId) : Work
    }

    /** Saves the map and the satellite imagery of an area. Already-saved tiles are skipped. */
    fun download(bounds: Bounds, maxZoom: Int) {
        if (job?.isActive == true) return
        job = scope.launch {
            val satZoom = min(maxZoom, SATELLITE_MAX_ZOOM)
            val todo = TileMath.tilesIn(bounds, maxZoom).filterNot { map.has(it.z, it.x, it.y) }.map { Work.MapTile(it) }.toList() +
                TileMath.tilesIn(bounds, satZoom).filterNot { satellite.has(it.z, it.x, it.y) }.map { Work.SatTile(it) }.toList()
            val total = todo.size
            val done = AtomicInteger(0)
            val failed = AtomicInteger(0)
            val bytes = AtomicLong(0)
            fun report(running: Boolean) {
                _progress.value = Progress(done.get(), total, bytes.get(), failed.get(), running)
            }
            report(true)
            val queue = Channel<Work>(Channel.UNLIMITED)
            todo.forEach { queue.trySend(it) }
            queue.close()
            try {
                coroutineScope {
                    repeat(WORKERS) {
                        launch {
                            for (work in queue) {
                                if (!isActive) break
                                val size = saveWithRetries(work)
                                if (size < 0) failed.incrementAndGet() else bytes.addAndGet(size.toLong())
                                // Coarse progress: no need to redraw for every tile.
                                if (done.incrementAndGet() % 10 == 0) report(true)
                            }
                        }
                    }
                }
                // Only a finished download raises the zoom MapLibre asks for; a cancelled one would leave holes.
                map.raiseMaxZoom(maxZoom)
                satellite.raiseMaxZoom(satZoom)
            } finally {
                report(false)
                _version.value++
            }
        }
    }

    /** Bytes saved (0 for a tile that doesn't exist), or -1 when it kept failing. */
    private fun saveWithRetries(work: Work): Int {
        val (z, x, y) = work.tile
        repeat(3) {
            try {
                return when (work) {
                    is Work.MapTile -> {
                        // An empty row still marks the tile as done (open sea, no data).
                        val data = planet.getTile(z, x, y) ?: ByteArray(0)
                        map.put(z, x, y, data)
                        data.size
                    }
                    is Work.SatTile -> {
                        val data = fetchSatellite(z, x, y) ?: return 0
                        satellite.put(z, x, y, data)
                        data.size
                    }
                }
            } catch (_: IOException) {
                // try again
            }
        }
        return -1
    }

    private fun fetchSatellite(z: Int, x: Int, y: Int): ByteArray? {
        val c = URL(String.format(SATELLITE_URL, z, y, x)).openConnection() as HttpURLConnection
        c.connectTimeout = 15_000
        c.readTimeout = 30_000
        try {
            if (c.responseCode == 404) return null
            if (c.responseCode != 200) throw IOException("HTTP ${c.responseCode}")
            return c.inputStream.use { it.readBytes() }
        } finally {
            c.disconnect()
        }
    }
}
