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
import androidx.compose.runtime.collectAsState
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
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.TextButton
import com.nob.sondetracker.offline.Bounds
import com.nob.sondetracker.offline.MapDownloadDialog
import com.nob.sondetracker.offline.OfflineMaps
import com.nob.sondetracker.team.MemberColors
import org.maplibre.android.style.layers.Property
import org.maplibre.android.style.layers.PropertyFactory.visibility
import com.nob.sondetracker.team.Team
import kotlinx.coroutines.delay
import org.maplibre.android.location.LocationComponentOptions
import org.maplibre.android.style.expressions.Expression.eq
import org.maplibre.android.style.expressions.Expression.geometryType
import org.maplibre.android.style.expressions.Expression.get
import org.maplibre.android.style.expressions.Expression.literal
import org.maplibre.android.style.expressions.Expression.toColor
import org.maplibre.android.style.layers.CircleLayer
import org.maplibre.android.style.layers.LineLayer
import org.maplibre.android.style.layers.PropertyFactory.circleColor
import org.maplibre.android.style.layers.PropertyFactory.circleRadius
import org.maplibre.android.style.layers.PropertyFactory.circleStrokeColor
import org.maplibre.android.style.layers.PropertyFactory.circleStrokeWidth
import org.maplibre.android.style.layers.PropertyFactory.lineCap
import org.maplibre.android.style.layers.PropertyFactory.lineColor
import org.maplibre.android.style.layers.PropertyFactory.lineJoin
import org.maplibre.android.style.layers.PropertyFactory.lineWidth
import org.maplibre.android.style.layers.PropertyFactory.textAllowOverlap
import org.maplibre.android.style.layers.PropertyFactory.textAnchor
import org.maplibre.android.style.layers.PropertyFactory.textColor
import org.maplibre.android.style.layers.PropertyFactory.textField
import org.maplibre.android.style.layers.PropertyFactory.textFont
import org.maplibre.android.style.layers.PropertyFactory.textHaloColor
import org.maplibre.android.style.layers.PropertyFactory.textHaloWidth
import org.maplibre.android.style.layers.PropertyFactory.textOffset
import org.maplibre.android.style.layers.PropertyFactory.textSize
import org.maplibre.android.style.layers.PropertyValue
import org.maplibre.android.style.layers.SymbolLayer
import org.maplibre.android.style.sources.GeoJsonSource
import org.maplibre.geojson.Feature
import org.maplibre.geojson.FeatureCollection
import org.maplibre.geojson.LineString
import org.maplibre.geojson.Point
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

/** Place names in Spanish unless the phone is set to English. */
private fun mapLang() = if (Locale.getDefault().language == "en") "en" else "es"

/** The style built on the tiles saved on the phone (see OfflineMaps). */
private fun offlineStyle(satellite: Boolean) = Style.Builder().fromJson(OfflineMaps.styleJson(mapLang(), satellite))

/** Satellite: imagery with the map's labels on top. Switched by visibility, no reload. */
private fun applyBasemap(style: Style, satellite: Boolean) {
    style.getLayer(OfflineMaps.SATELLITE_LAYER)?.setProperties(visibility(if (satellite) Property.VISIBLE else Property.NONE))
    for (id in OfflineMaps.baseLayers) {
        style.getLayer(id)?.setProperties(visibility(if (satellite) Property.NONE else Property.VISIBLE))
    }
}

private const val TEAM_SOURCE = "team"
private const val SONDE_SOURCE = "sonde"

/** Sources and layers for the team, the base and the balloon, on top of the basemap. */
private fun addTeamLayers(style: Style) {
    style.addSource(GeoJsonSource(TEAM_SOURCE))
    style.addSource(GeoJsonSource(SONDE_SOURCE))
    val label: Array<PropertyValue<*>> = arrayOf(
        textField(get("label")),
        textFont(arrayOf("Noto Sans Medium")),
        textSize(12f),
        textAnchor("left"),
        textOffset(arrayOf(1f, 0f)),
        textAllowOverlap(true),
        textColor("#e4ebf3"),
        textHaloColor("#0a0e14"),
        textHaloWidth(1.5f),
    )
    style.addLayer(
        LineLayer("sonde-track", SONDE_SOURCE)
            .withFilter(eq(geometryType(), literal("LineString")))
            .withProperties(lineColor("#5cc8ff"), lineWidth(3f), lineCap("round"), lineJoin("round")),
    )
    style.addLayer(
        CircleLayer("sonde-dot", SONDE_SOURCE)
            .withFilter(eq(geometryType(), literal("Point")))
            .withProperties(circleRadius(8f), circleColor("#ff7ad9"), circleStrokeWidth(2f), circleStrokeColor("#ffffff")),
    )
    style.addLayer(SymbolLayer("sonde-label", SONDE_SOURCE).withFilter(eq(geometryType(), literal("Point"))).withProperties(*label))
    style.addLayer(
        CircleLayer("team-dot", TEAM_SOURCE)
            .withProperties(circleRadius(7f), circleColor(toColor(get("color"))), circleStrokeWidth(2f), circleStrokeColor("#0a0e14")),
    )
    style.addLayer(SymbolLayer("team-label", TEAM_SOURCE).withProperties(*label))
}

private fun point(lon: Double, lat: Double, label: String, color: String? = null): Feature =
    Feature.fromGeometry(Point.fromLngLat(lon, lat)).apply {
        addStringProperty("label", label)
        if (color != null) addStringProperty("color", color)
    }

private fun updateTeamLayers(style: Style, members: Collection<Team.Member>, base: Team.Member?, baseLabel: String, sonde: List<Team.SondePoint>) {
    val team = members.map { point(it.lon, it.lat, it.name, MemberColors.of(it.id)) } +
        listOfNotNull(base?.let { point(it.lon, it.lat, baseLabel, "#3fd18b") })
    style.getSourceAs<GeoJsonSource>(TEAM_SOURCE)?.setGeoJson(FeatureCollection.fromFeatures(team))
    val last = sonde.lastOrNull()
    val balloon = if (last == null) emptyList() else listOf(
        Feature.fromGeometry(LineString.fromLngLats(sonde.map { Point.fromLngLat(it.lon, it.lat) })),
        point(last.lon, last.lat, "${last.serial}\n${last.alt.toInt()} m"),
    )
    style.getSourceAs<GeoJsonSource>(SONDE_SOURCE)?.setGeoJson(FeatureCollection.fromFeatures(balloon))
}

@Composable
fun MapScreen(onOpenTeam: () -> Unit) {
    val context = LocalContext.current
    val mapView = rememberMapViewWithLifecycle()
    var map by remember { mutableStateOf<MapLibreMap?>(null) }
    var style by remember { mutableStateOf<Style?>(null) }
    var permitted by remember { mutableStateOf(hasLocationPermission(context)) }
    var myLocation by remember { mutableStateOf<Location?>(null) }
    var satellite by remember { mutableStateOf(OfflineMaps.satelliteView) }
    // Whether the area in view is saved on the phone; asks to download it when not.
    var covered by remember { mutableStateOf(true) }
    var showDownload by remember { mutableStateOf(false) }
    val mapsVersion by OfflineMaps.version.collectAsState()
    val download by OfflineMaps.progress.collectAsState()

    val askPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        permitted = result[Manifest.permission.ACCESS_FINE_LOCATION] == true
    }

    LaunchedEffect(Unit) {
        if (!permitted) {
            askPermission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
        }
        mapView.getMapAsync { m ->
            m.cameraPosition = CameraPosition.Builder().target(START).zoom(8.0).build()
            m.setStyle(offlineStyle(satellite)) { s ->
                addTeamLayers(s)
                style = s
            }
            m.addOnCameraIdleListener {
                val camera = m.cameraPosition
                camera.target?.let { covered = OfflineMaps.covered(it.latitude, it.longitude, camera.zoom) }
            }
            map = m
        }
    }

    // New tiles were saved (or deleted): reload, so the map shows them.
    LaunchedEffect(mapsVersion) {
        val m = map ?: return@LaunchedEffect
        if (mapsVersion == 0) return@LaunchedEffect
        m.setStyle(offlineStyle(satellite)) { s ->
            addTeamLayers(s)
            style = s
        }
        m.cameraPosition.target?.let { covered = OfflineMaps.covered(it.latitude, it.longitude, m.cameraPosition.zoom) }
    }

    LaunchedEffect(style, satellite) {
        style?.let { applyBasemap(it, satellite) }
    }

    // Turn on the "me" marker once both the style and the permission are there.
    LaunchedEffect(map, style, permitted) {
        val m = map ?: return@LaunchedEffect
        val s = style ?: return@LaunchedEffect
        if (permitted) showMyLocation(context, m, s)
    }

    LaunchedEffect(permitted) {
        if (permitted) Team.startLocation()
    }

    val members by Team.members.collectAsState()
    val base by Team.base.collectAsState()
    val sonde by Team.sonde.collectAsState()
    val node by Team.node.collectAsState()
    val baseLabel = stringResource(R.string.map_base)
    LaunchedEffect(style, members, base, sonde) {
        style?.let { updateTeamLayers(it, members.values, base, baseLabel, sonde) }
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
                Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                    Text(status, style = MaterialTheme.typography.bodyMedium)
                    val net = when {
                        node.onNetwork -> stringResource(R.string.map_net, node.net ?: "", members.size)
                        node.kicked -> stringResource(R.string.map_kicked)
                        else -> stringResource(R.string.map_no_net)
                    }
                    Text(net, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilledTonalButton(onClick = {
                    satellite = !satellite
                    OfflineMaps.satelliteView = satellite
                }) { Text(stringResource(if (satellite) R.string.map_normal else R.string.map_satellite)) }
                FilledTonalButton(onClick = { showDownload = true }) { Text(stringResource(R.string.maps_button)) }
            }
            if (!covered && download?.running != true) {
                Surface(
                    Modifier.padding(top = 8.dp),
                    color = MaterialTheme.colorScheme.surface.copy(alpha = 0.92f),
                    shape = MaterialTheme.shapes.medium,
                ) {
                    Row(Modifier.padding(start = 12.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(stringResource(R.string.map_not_downloaded), style = MaterialTheme.typography.bodySmall)
                        TextButton(onClick = { showDownload = true }) { Text(stringResource(R.string.maps_download)) }
                    }
                }
            }
        }

        val phone = Team.me.collectAsState().value
        if (showDownload) {
            val visible = map?.projection?.visibleRegion?.latLngBounds?.let { Bounds(it.lonWest, it.latSouth, it.lonEast, it.latNorth) }
            MapDownloadDialog(visible = visible, me = phone, onDismiss = { showDownload = false })
        }
        val balloon = sonde.lastOrNull()
        if (balloon != null) {
            BalloonCompass(
                me = phone,
                balloon = balloon,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .safeDrawingPadding()
                    .padding(bottom = 84.dp),
            )
        }

        ExtendedFloatingActionButton(
            onClick = onOpenTeam,
            modifier = Modifier
                .align(Alignment.BottomStart)
                .safeDrawingPadding()
                .padding(16.dp),
        ) { Text(stringResource(R.string.team_title)) }

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
                .locationComponentOptions(myMarker(context))
                .build(),
        )
    }
    lc.isLocationComponentEnabled = true
    lc.renderMode = RenderMode.GPS
    followMe(map)
}

/** Me on the map: just a small arrow, no halo or accuracy circle. */
private fun myMarker(context: Context): LocationComponentOptions =
    LocationComponentOptions.builder(context)
        .gpsDrawable(R.drawable.ic_me_arrow)
        .foregroundDrawable(R.drawable.ic_me_arrow)
        .backgroundDrawable(R.drawable.ic_transparent)
        .bearingDrawable(R.drawable.ic_transparent)
        .accuracyAlpha(0f)
        .elevation(0f)
        .pulseEnabled(false)
        .maxZoomIconScale(1f)
        .minZoomIconScale(0.8f)
        .build()

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
