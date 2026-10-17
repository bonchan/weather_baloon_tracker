package com.nob.sondetracker.offline

import android.location.Location
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.nob.sondetracker.R

private const val AROUND_ME_KM = 200.0
private val ZOOMS = listOf(10, 11, 12, 13, 14)

private fun megabytes(bytes: Long) = "%.1f MB".format(bytes / 1_048_576.0)

/**
 * Saves the area on screen (or around me) for offline use: the map and the satellite imagery
 * together, so both views work with no internet.
 */
@Composable
fun MapDownloadDialog(visible: Bounds?, me: Location?, onDismiss: () -> Unit) {
    val progress by OfflineMaps.progress.collectAsState()
    var aroundMe by remember { mutableStateOf(false) }
    var maxZoom by remember { mutableIntStateOf(12) }
    var confirmDelete by remember { mutableStateOf(false) }
    val running = progress?.running == true

    val bounds = if (aroundMe && me != null) TileMath.boundsAround(me.latitude, me.longitude, AROUND_ME_KM) else visible
    val estimate = bounds?.let { OfflineMaps.estimate(it, maxZoom) } ?: 0L
    val tooBig = estimate > OfflineMaps.MAX_DOWNLOAD_TILES

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.maps_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(stringResource(R.string.maps_help), style = MaterialTheme.typography.bodySmall)

                Text(stringResource(R.string.maps_area), style = MaterialTheme.typography.labelMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(selected = !aroundMe, onClick = { aroundMe = false }, label = { Text(stringResource(R.string.maps_area_view)) })
                    FilterChip(
                        selected = aroundMe,
                        enabled = me != null,
                        onClick = { aroundMe = true },
                        label = { Text(stringResource(R.string.maps_area_me, AROUND_ME_KM.toInt())) },
                    )
                }

                Text(stringResource(R.string.maps_detail), style = MaterialTheme.typography.labelMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    ZOOMS.forEach { z ->
                        FilterChip(selected = maxZoom == z, onClick = { maxZoom = z }, label = { Text("$z") })
                    }
                }
                Text(stringResource(R.string.maps_detail_help), style = MaterialTheme.typography.bodySmall)

                Text(
                    if (tooBig) stringResource(R.string.maps_too_big, estimate) else stringResource(R.string.maps_estimate, estimate),
                    color = if (tooBig) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall,
                )

                progress?.let { p ->
                    if (p.total > 0) LinearProgressIndicator(progress = { p.done.toFloat() / p.total }, modifier = Modifier.fillMaxWidth())
                    Text(
                        stringResource(if (p.running) R.string.maps_progress else R.string.maps_done, p.done, p.total, megabytes(p.bytes)),
                        style = MaterialTheme.typography.bodySmall,
                    )
                    if (!p.running && p.failed > 0) {
                        Text(stringResource(R.string.maps_failed, p.failed), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    }
                }

                Text(stringResource(R.string.maps_storage, megabytes(OfflineMaps.storageBytes())), style = MaterialTheme.typography.bodySmall)
                if (confirmDelete) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = {
                            OfflineMaps.deleteAll()
                            confirmDelete = false
                        }) { Text(stringResource(R.string.maps_delete_confirm)) }
                        TextButton(onClick = { confirmDelete = false }) { Text(stringResource(R.string.cancel)) }
                    }
                } else {
                    TextButton(onClick = { confirmDelete = true }, enabled = !running) { Text(stringResource(R.string.maps_delete)) }
                }
            }
        },
        confirmButton = {
            if (running) {
                TextButton(onClick = OfflineMaps::cancel) { Text(stringResource(R.string.maps_cancel)) }
            } else {
                Button(onClick = { bounds?.let { OfflineMaps.download(it, maxZoom) } }, enabled = bounds != null && !tooBig) {
                    Text(stringResource(R.string.maps_download))
                }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.close)) } },
    )
}
