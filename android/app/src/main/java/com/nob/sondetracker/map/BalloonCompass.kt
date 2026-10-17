package com.nob.sondetracker.map

import android.content.Context
import android.hardware.GeomagneticField
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.os.SystemClock
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.nob.sondetracker.R
import com.nob.sondetracker.team.Team
import kotlinx.coroutines.delay
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin

/** Moving faster than this, the GPS course is a usable heading for phones without a compass. */
private const val COURSE_MIN_SPEED = 1.5f
/** The balloon sends a frame every second; this long without one and the position is getting old. */
private const val BALLOON_STALE_MS = 30_000L

/**
 * Where the top of the phone points, in degrees from magnetic north, while it lies flat.
 * Null when the phone has no compass (rotation vector, or accelerometer + magnetometer).
 */
@Composable
private fun rememberDeviceAzimuth(): Float? {
    val context = LocalContext.current
    var azimuth by remember { mutableStateOf<Float?>(null) }
    DisposableEffect(Unit) {
        val sm = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
        val rotationSensor = sm.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
        val accel = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        val magnet = sm.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD)
        val matrix = FloatArray(9)
        val orientation = FloatArray(3)
        val gravity = FloatArray(3)
        val field = FloatArray(3)
        var haveGravity = false
        var haveField = false
        // Smoothed as a unit vector, so 359° -> 1° doesn't swing the arrow the long way round.
        var sx = 0f
        var sy = 0f

        fun publish() {
            SensorManager.getOrientation(matrix, orientation)
            val a = orientation[0]
            sx = sx * 0.85f + sin(a) * 0.15f
            sy = sy * 0.85f + cos(a) * 0.15f
            azimuth = (Math.toDegrees(atan2(sx, sy).toDouble()).toFloat() + 360f) % 360f
        }

        val listener = object : SensorEventListener {
            override fun onSensorChanged(e: SensorEvent) {
                when (e.sensor.type) {
                    Sensor.TYPE_ROTATION_VECTOR -> {
                        SensorManager.getRotationMatrixFromVector(matrix, e.values)
                        publish()
                    }
                    Sensor.TYPE_ACCELEROMETER -> {
                        e.values.copyInto(gravity, endIndex = 3)
                        haveGravity = true
                    }
                    Sensor.TYPE_MAGNETIC_FIELD -> {
                        e.values.copyInto(field, endIndex = 3)
                        haveField = true
                        if (haveGravity && SensorManager.getRotationMatrix(matrix, null, gravity, field)) publish()
                    }
                }
            }

            override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) = Unit
        }

        if (rotationSensor != null) {
            sm.registerListener(listener, rotationSensor, SensorManager.SENSOR_DELAY_UI)
        } else if (accel != null && magnet != null) {
            sm.registerListener(listener, accel, SensorManager.SENSOR_DELAY_UI)
            sm.registerListener(listener, magnet, SensorManager.SENSOR_DELAY_UI)
        }
        onDispose { sm.unregisterListener(listener) }
    }
    return azimuth
}

private fun formatDistance(m: Float) = if (m < 1000) "${m.toInt()} m" else "%.1f km".format(m / 1000)

/**
 * An arrow that points at the balloon whatever the map does, for holding the phone flat,
 * plus the distance. Uses the compass when there is one, else the direction of travel.
 */
@Composable
fun BalloonCompass(me: Location?, balloon: Team.SondePoint, modifier: Modifier = Modifier) {
    val azimuth = rememberDeviceAzimuth()
    var now by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
    LaunchedEffect(Unit) {
        while (true) {
            now = SystemClock.elapsedRealtime()
            delay(1000)
        }
    }
    val age = (now - balloon.heardAt).coerceAtLeast(0)
    val result = FloatArray(2)
    if (me != null) Location.distanceBetween(me.latitude, me.longitude, balloon.lat, balloon.lon, result)
    val distance = result[0]
    val bearing = (result[1] + 360f) % 360f

    val heading: Float? = when {
        me == null -> null
        azimuth != null -> {
            // Magnetic to true north, for where we are.
            val declination = GeomagneticField(
                me.latitude.toFloat(), me.longitude.toFloat(), me.altitude.toFloat(), System.currentTimeMillis(),
            ).declination
            (azimuth + declination + 360f) % 360f
        }
        me.hasBearing() && me.hasSpeed() && me.speed >= COURSE_MIN_SPEED -> me.bearing
        else -> null
    }

    Surface(modifier, color = MaterialTheme.colorScheme.surface.copy(alpha = 0.92f), shape = MaterialTheme.shapes.large) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            val arrowColor = if (heading != null) Color(0xFFFF7AD9) else Color(0xFF8796A8)
            // Without a heading the arrow shows the bearing from north (top = north).
            val angle = bearing - (heading ?: 0f)
            if (me != null) Canvas(Modifier.size(56.dp).rotate(angle)) {
                val w = size.width
                val h = size.height
                val arrow = Path().apply {
                    moveTo(w / 2, h * 0.05f)
                    lineTo(w * 0.82f, h * 0.9f)
                    lineTo(w / 2, h * 0.7f)
                    lineTo(w * 0.18f, h * 0.9f)
                    close()
                }
                drawPath(arrow, arrowColor)
                drawPath(arrow, Color(0xFF0A0E14), style = Stroke(width = 3f))
            }
            if (me != null) Spacer(Modifier.width(12.dp))
            Column {
                if (me != null) {
                    Text(formatDistance(distance), style = MaterialTheme.typography.headlineSmall, fontFamily = FontFamily.Monospace)
                }
                Text(
                    stringResource(R.string.compass_balloon, balloon.serial, balloon.alt.toInt()),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    stringResource(R.string.compass_heard, age / 1000),
                    style = MaterialTheme.typography.bodySmall,
                    color = if (age > BALLOON_STALE_MS) Color(0xFFF5B942) else MaterialTheme.colorScheme.onSurfaceVariant,
                )
                val hint = when {
                    me == null -> stringResource(R.string.compass_no_gps)
                    azimuth != null -> null
                    heading != null -> stringResource(R.string.compass_by_course)
                    else -> stringResource(R.string.compass_no_heading, bearing.toInt())
                }
                hint?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}
