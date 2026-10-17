package com.nob.sondetracker.team

import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Build
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.nob.sondetracker.link.NodeLink
import com.nob.sondetracker.link.Pstk
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlin.random.Random

/**
 * The search team as this phone sees it: the Heltec node it is paired with, the team network,
 * the base station, the other satellites and the balloon. Lives as long as the app process.
 */
@SuppressLint("StaticFieldLeak") // holds the application context only
object Team {
    data class Member(
        val id: String,
        val lat: Double,
        val lon: Double,
        val alt: Double?,
        val rssi: Double?,
        val snr: Double?,
        /** SystemClock.elapsedRealtime() when heard */
        val heardAt: Long,
    )

    data class SondePoint(val serial: String, val frame: Int, val lat: Double, val lon: Double, val alt: Double, val climb: Double?, val heardAt: Long)

    /** What the paired node says about itself. */
    data class Node(
        /** The node's team network; null until it told us. */
        val net: String? = null,
        val device: String? = null,
        val name: String? = null,
        val joinPending: Boolean = false,
        val rejected: Boolean = false,
        val lastError: String? = null,
    ) {
        val onNetwork: Boolean get() = net != null && net != Pstk.NO_NET
    }

    private const val SEND_EVERY_MS = 15_000L
    private const val STALE_FIX_MS = 30_000L

    private lateinit var context: Context
    private lateinit var prefs: SharedPreferences
    private val main = Handler(Looper.getMainLooper())

    lateinit var link: NodeLink
        private set

    private val _node = MutableStateFlow(Node())
    val node: StateFlow<Node> = _node
    private val _callsign = MutableStateFlow("")
    val callsign: StateFlow<String> = _callsign
    private val _members = MutableStateFlow<Map<String, Member>>(emptyMap())
    val members: StateFlow<Map<String, Member>> = _members
    private val _base = MutableStateFlow<Member?>(null)
    val base: StateFlow<Member?> = _base
    private val _sonde = MutableStateFlow<List<SondePoint>>(emptyList())
    val sonde: StateFlow<List<SondePoint>> = _sonde
    private val _me = MutableStateFlow<Location?>(null)
    val me: StateFlow<Location?> = _me
    private val _lastSentAt = MutableStateFlow<Long?>(null)
    val lastSentAt: StateFlow<Long?> = _lastSentAt

    private var started = false

    fun init(appContext: Context) {
        if (started) return
        started = true
        context = appContext.applicationContext
        prefs = context.getSharedPreferences("team", Context.MODE_PRIVATE)
        _callsign.value = prefs.getString("callsign", "") ?: ""
        link = NodeLink(context, ::onLine)
        // Reconnect to the paired node, unless Android 12+ hasn't granted Bluetooth yet (it would throw).
        prefs.getString("node", null)?.takeIf { hasBluetoothPermission() }?.let { link.connect(it) }
        scheduleSend()
    }

    private fun hasBluetoothPermission() =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            context.checkSelfPermission(android.Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED

    fun setCallsign(value: String) {
        val v = Pstk.normalizeCallsign(value)
        _callsign.value = v
        prefs.edit().putString("callsign", v).apply()
    }

    /** Pairs with a node; remembered and reconnected on the next launches. */
    fun connect(address: String) {
        prefs.edit().putString("node", address).apply()
        _node.value = Node()
        link.connect(address)
    }

    fun forget() {
        prefs.edit().remove("node").apply()
        link.disconnect()
        _node.value = Node()
    }

    fun join() {
        val cs = _callsign.value
        if (!Pstk.isValidCallsign(cs)) return
        if (link.send("PSTK,JOIN,$cs")) _node.value = _node.value.copy(joinPending = true, rejected = false, lastError = null)
    }

    fun leave() {
        link.send("PSTK,LEAVE")
    }

    // ---------------------------------------------------------------- phone GPS

    private val locationListener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            _me.value = location
        }

        @Deprecated("Needed below API 29")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
        override fun onProviderEnabled(provider: String) = Unit
        override fun onProviderDisabled(provider: String) = Unit
    }

    /** Call once location permission is granted. */
    @SuppressLint("MissingPermission")
    fun startLocation() {
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        lm.removeUpdates(locationListener)
        if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
            lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 2000L, 0f, locationListener, Looper.getMainLooper())
        }
        if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
            lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 5000L, 0f, locationListener, Looper.getMainLooper())
        }
    }

    // ---------------------------------------------------------------- sending my position

    private fun scheduleSend() {
        // A little jitter so phones that started together don't keep colliding on air.
        main.postDelayed({
            sendMine()
            scheduleSend()
        }, SEND_EVERY_MS + Random.nextLong(0, 2000))
    }

    private fun sendMine() {
        val me = _me.value ?: return
        val cs = _callsign.value
        if (!_node.value.onNetwork || !Pstk.isValidCallsign(cs)) return
        if (System.currentTimeMillis() - me.time > STALE_FIX_MS) return
        val body = Pstk.posBody(
            src = cs,
            lat = me.latitude,
            lon = me.longitude,
            alt = if (me.hasAltitude()) me.altitude else null,
            speed = if (me.hasSpeed()) me.speed.toDouble() else null,
            course = if (me.hasBearing()) me.bearing.toDouble() else null,
            utc = me.time / 1000,
        )
        if (link.send("PSTK,TX,$body")) _lastSentAt.value = SystemClock.elapsedRealtime()
    }

    // ---------------------------------------------------------------- lines from the node

    private fun onLine(line: String) {
        when (val msg = Pstk.parse(line)) {
            is Pstk.Id -> _node.value = _node.value.copy(net = msg.net, device = msg.device, name = msg.name)
            is Pstk.Bound -> _node.value = _node.value.copy(net = msg.net, joinPending = false, rejected = false)
            Pstk.Rejected -> _node.value = _node.value.copy(joinPending = false, rejected = true)
            is Pstk.Log -> if (msg.error) _node.value = _node.value.copy(lastError = msg.text)
            is Pstk.Heard -> heard(msg)
            else -> Unit
        }
    }

    private fun heard(h: Pstk.Heard) {
        val now = SystemClock.elapsedRealtime()
        when (val inner = h.inner) {
            is Pstk.Pos -> {
                if (inner.src == _callsign.value) return // our own position, relayed back by the base
                val m = Member(inner.src, inner.lat, inner.lon, inner.alt, h.rssi, h.snr, now)
                if (inner.src == Pstk.SRC_BASE) _base.value = m
                else _members.value = _members.value + (inner.src to m)
            }
            is Pstk.Sonde -> {
                val track = _sonde.value
                val last = track.lastOrNull()
                if (last != null && last.serial == inner.serial && last.frame == inner.frame) return
                // A new serial is a new flight: start its track over.
                val kept = if (last != null && last.serial != inner.serial) emptyList() else track
                _sonde.value = kept + SondePoint(inner.serial, inner.frame, inner.lat, inner.lon, inner.alt, inner.climb, now)
            }
            else -> Unit
        }
    }
}
