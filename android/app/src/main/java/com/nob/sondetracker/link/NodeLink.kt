package com.nob.sondetracker.link

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.util.UUID

/**
 * Bluetooth link to the Heltec satellite node (arduino/heltec_companion), over the Nordic UART
 * service: we write $PSTK lines to RX, the node notifies its lines on TX. Every callback is moved
 * to the main thread, so state needs no locking.
 * Callers must hold the Bluetooth permissions (and location on Android 11 and older).
 */
@SuppressLint("MissingPermission")
class NodeLink(context: Context, private val onLine: (String) -> Unit) {
    enum class Phase { IDLE, SCANNING, CONNECTING, CONNECTED }

    data class Found(val address: String, val name: String, val rssi: Int)

    private val context = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val adapter = (context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter

    private val _phase = MutableStateFlow(Phase.IDLE)
    val phase: StateFlow<Phase> = _phase
    private val _found = MutableStateFlow<List<Found>>(emptyList())
    val found: StateFlow<List<Found>> = _found
    /** Address of the node we are (or want to be) connected to. */
    private val _address = MutableStateFlow<String?>(null)
    val address: StateFlow<String?> = _address

    private var gatt: BluetoothGatt? = null
    private var rx: BluetoothGattCharacteristic? = null
    private var mtu = 23
    private val writes = ArrayDeque<ByteArray>()
    private var writing = false
    private val incoming = StringBuilder()
    /** Keep reconnecting to [address] until [disconnect] is called. */
    private var wanted = false

    val bluetoothOn: Boolean get() = adapter?.isEnabled == true

    fun startScan() {
        val scanner = adapter?.bluetoothLeScanner ?: return
        if (_phase.value != Phase.IDLE) return
        _found.value = emptyList()
        _phase.value = Phase.SCANNING
        val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE)).build()
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        scanner.startScan(listOf(filter), settings, scanCallback)
        main.postDelayed(stopScanLater, SCAN_MS)
    }

    fun stopScan() {
        main.removeCallbacks(stopScanLater)
        if (_phase.value != Phase.SCANNING) return
        adapter?.bluetoothLeScanner?.stopScan(scanCallback)
        _phase.value = Phase.IDLE
    }

    private val stopScanLater = Runnable { stopScan() }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            main.post {
                val d = result.device
                val name = result.scanRecord?.deviceName ?: d.name ?: d.address
                val others = _found.value.filter { it.address != d.address }
                _found.value = (others + Found(d.address, name, result.rssi)).sortedByDescending { it.rssi }
            }
        }
    }

    fun connect(address: String) {
        stopScan()
        closeGatt()
        _address.value = address
        wanted = true
        open()
    }

    fun disconnect() {
        wanted = false
        main.removeCallbacksAndMessages(RECONNECT)
        closeGatt()
        _phase.value = Phase.IDLE
    }

    /** Sends one sentence body (e.g. "PSTK,JOIN,JUAN"); false when not connected. */
    fun send(body: String): Boolean {
        if (_phase.value != Phase.CONNECTED || rx == null) return false
        val bytes = (Pstk.sentence(body) + "\r\n").toByteArray(Charsets.US_ASCII)
        val chunk = (mtu - 3).coerceAtLeast(20)
        var i = 0
        while (i < bytes.size) {
            writes.addLast(bytes.copyOfRange(i, minOf(i + chunk, bytes.size)))
            i += chunk
        }
        pump()
        return true
    }

    private fun open() {
        val address = _address.value ?: return
        val device = adapter?.getRemoteDevice(address) ?: return
        _phase.value = Phase.CONNECTING
        gatt = device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
    }

    private fun closeGatt() {
        gatt?.close()
        gatt = null
        rx = null
        writes.clear()
        writing = false
        incoming.clear()
    }

    private fun scheduleReconnect() {
        if (!wanted) return
        main.removeCallbacksAndMessages(RECONNECT)
        main.postAtTime({ if (wanted && gatt == null) open() }, RECONNECT, android.os.SystemClock.uptimeMillis() + RECONNECT_MS)
    }

    @Suppress("DEPRECATION") // the pre-API-33 calls are the ones Android 8.1 has
    private fun pump() {
        val g = gatt ?: return
        val c = rx ?: return
        if (writing) return
        val next = writes.removeFirstOrNull() ?: return
        c.value = next
        c.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        writing = g.writeCharacteristic(c)
        if (!writing) writes.clear()
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            main.post {
                if (g != gatt) return@post
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    // A $PSTK line fits one notification once the MTU is raised.
                    if (!g.requestMtu(WANTED_MTU)) g.discoverServices()
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    closeGatt()
                    _phase.value = Phase.IDLE
                    scheduleReconnect()
                }
            }
        }

        override fun onMtuChanged(g: BluetoothGatt, value: Int, status: Int) {
            main.post {
                if (status == BluetoothGatt.GATT_SUCCESS) mtu = value
                g.discoverServices()
            }
        }

        @Suppress("DEPRECATION")
        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            main.post {
                val service = g.getService(SERVICE)
                val tx = service?.getCharacteristic(TX)
                rx = service?.getCharacteristic(RX)
                if (tx == null || rx == null) {
                    g.disconnect()
                    return@post
                }
                g.setCharacteristicNotification(tx, true)
                val cccd = tx.getDescriptor(CCCD)
                cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                g.writeDescriptor(cccd)
            }
        }

        override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            main.post {
                _phase.value = Phase.CONNECTED
                send("PSTK,HELLO")
            }
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
            main.post {
                writing = false
                pump()
            }
        }

        @Deprecated("Android 8.1 only has this one")
        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
            val text = c.value?.toString(Charsets.US_ASCII) ?: return
            main.post { receive(text) }
        }

        // Android 13+ calls this one instead, with the value it no longer stores on c.
        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) {
            val text = value.toString(Charsets.US_ASCII)
            main.post { receive(text) }
        }
    }

    /** Notifications may cut or join lines; hand out whole lines. */
    private fun receive(text: String) {
        incoming.append(text)
        while (true) {
            val end = incoming.indexOf("\n")
            if (end < 0) break
            val line = incoming.substring(0, end).trim()
            incoming.delete(0, end + 1)
            if (line.isNotEmpty()) onLine(line)
        }
        if (incoming.length > 1024) incoming.clear()
    }

    companion object {
        val SERVICE: UUID = UUID.fromString("6E400001-B5A3-F393-E0A9-E50E24DCCA9E")
        private val RX: UUID = UUID.fromString("6E400002-B5A3-F393-E0A9-E50E24DCCA9E")
        private val TX: UUID = UUID.fromString("6E400003-B5A3-F393-E0A9-E50E24DCCA9E")
        private val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        private const val WANTED_MTU = 185
        private const val SCAN_MS = 12_000L
        private const val RECONNECT_MS = 5_000L
        private val RECONNECT = Any()
    }
}
