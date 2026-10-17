package com.nob.sondetracker.map

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.nob.sondetracker.R
import kotlinx.coroutines.delay
import org.maplibre.android.MapLibre
import org.maplibre.android.camera.CameraPosition
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.location.LocationComponentActivationOptions
import org.maplibre.android.location.modes.CameraMode
import org.maplibre.android.location.modes.RenderMode
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.maps.MapView
import org.maplibre.android.maps.Style
import java.util.Locale

/** Neuquén Aero: where the map opens before the phone has a fix. */
private val START = LatLng(-38.949, -68.156)

/** A fix older than this counts as "no GPS". */
private const val STALE_FIX_MS = 30_000L

private fun hasLocationPermission(context: Context) =
    ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED

/** Bundled style (assets/map), with place names in Spanish unless the phone is set to English. */
private fun styleUri(): String {
    val lang = if (Locale.getDefault().language == "en") "en" else "es"
    return "asset://map/style-dark-$lang.json"
}

@Composable
fun MapScreen() {
    val context = LocalContext.current
    val mapView = rememberMapViewWithLifecycle()
    var map by remember { mutableStateOf<MapLibreMap?>(null) }
    var style by remember { mutableStateOf<Style?>(null) }
    var permitted by remember { mutableStateOf(hasLocationPermission(context)) }
    var myLocation by remember { mutableStateOf<Location?>(null) }

    val askPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        permitted = result[Manifest.permission.ACCESS_FINE_LOCATION] == true
    }

    LaunchedEffect(Unit) {
        if (!permitted) {
            askPermission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
        }
        mapView.getMapAsync { m ->
            m.cameraPosition = CameraPosition.Builder().target(START).zoom(8.0).build()
            m.setStyle(Style.Builder().fromUri(styleUri())) { s -> style = s }
            map = m
        }
    }

    // Turn on the "me" marker once both the style and the permission are there.
    LaunchedEffect(map, style, permitted) {
        val m = map ?: return@LaunchedEffect
        val s = style ?: return@LaunchedEffect
        if (permitted) showMyLocation(context, m, s)
    }

    // Poll the location layer for the status text; it already tracks the GPS itself.
    LaunchedEffect(map, permitted) {
        val m = map ?: return@LaunchedEffect
        while (permitted) {
            myLocation = if (m.locationComponent.isLocationComponentActivated) m.locationComponent.lastKnownLocation else null
            delay(1000)
        }
    }

    Box(Modifier.fillMaxSize()) {
        AndroidView(factory = { mapView }, modifier = Modifier.fillMaxSize())

        val fresh = myLocation?.takeIf { System.currentTimeMillis() - it.time < STALE_FIX_MS }
        Column(
            Modifier
                .align(Alignment.TopCenter)
                .safeDrawingPadding()
                .padding(12.dp),
        ) {
            val status = when {
                !permitted -> stringResource(R.string.gps_no_permission)
                fresh == null -> stringResource(R.string.gps_waiting)
                else -> stringResource(
                    R.string.gps_fix,
                    String.format(Locale.US, "%.5f", fresh.latitude),
                    String.format(Locale.US, "%.5f", fresh.longitude),
                    fresh.accuracy.toInt(),
                )
            }
            Surface(
                color = MaterialTheme.colorScheme.surface.copy(alpha = 0.9f),
                shape = MaterialTheme.shapes.medium,
            ) {
                Text(status, Modifier.padding(horizontal = 12.dp, vertical = 8.dp), style = MaterialTheme.typography.bodyMedium)
            }
        }

        if (permitted) {
            ExtendedFloatingActionButton(
                onClick = { map?.let { followMe(it) } },
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .safeDrawingPadding()
                    .padding(16.dp),
            ) { Text(stringResource(R.string.map_me)) }
        }
    }
}

@SuppressLint("MissingPermission") // only called once the permission is granted
private fun showMyLocation(context: Context, map: MapLibreMap, style: Style) {
    val lc = map.locationComponent
    if (!lc.isLocationComponentActivated) {
        lc.activateLocationComponent(
            LocationComponentActivationOptions.builder(context, style)
                // MapLibre's own engine on top of Android's GPS: no Google Play services needed.
                .useDefaultLocationEngine(true)
                .build(),
        )
    }
    lc.isLocationComponentEnabled = true
    lc.renderMode = RenderMode.GPS
    followMe(map)
}

/** Centers on me and keeps following until the user pans the map. */
@SuppressLint("MissingPermission")
private fun followMe(map: MapLibreMap) {
    val lc = map.locationComponent
    if (!lc.isLocationComponentActivated) return
    lc.cameraMode = CameraMode.TRACKING_GPS
    if (map.cameraPosition.zoom < 13) lc.zoomWhileTracking(14.0)
}

/** A MapView that follows the screen's lifecycle, as MapLibre requires. */
@Composable
private fun rememberMapViewWithLifecycle(): MapView {
    val context = LocalContext.current
    val mapView = remember {
        MapLibre.getInstance(context)
        MapView(context).apply { onCreate(null) }
    }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, mapView) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> mapView.onStart()
                Lifecycle.Event.ON_RESUME -> mapView.onResume()
                Lifecycle.Event.ON_PAUSE -> mapView.onPause()
                Lifecycle.Event.ON_STOP -> mapView.onStop()
                Lifecycle.Event.ON_DESTROY -> mapView.onDestroy()
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    return mapView
}
