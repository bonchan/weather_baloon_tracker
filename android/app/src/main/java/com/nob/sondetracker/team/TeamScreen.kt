package com.nob.sondetracker.team

import android.Manifest
import android.os.Build
import android.os.SystemClock
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import com.nob.sondetracker.R
import com.nob.sondetracker.link.NodeLink
import com.nob.sondetracker.link.Pstk
import kotlinx.coroutines.delay

/** Bluetooth scanning needs these at run time (location below Android 12). */
fun bluetoothPermissions(): Array<String> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
    } else {
        arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
    }

@Composable
fun TeamScreen(onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    val node by Team.node.collectAsState()
    val phase by Team.link.phase.collectAsState()
    val found by Team.link.found.collectAsState()
    val paired by Team.link.address.collectAsState()
    val callsign by Team.callsign.collectAsState()
    val members by Team.members.collectAsState()
    val base by Team.base.collectAsState()
    val lastSent by Team.lastSentAt.collectAsState()
    var now by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
    var denied by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        while (true) {
            now = SystemClock.elapsedRealtime()
            delay(1000)
        }
    }

    val askBluetooth = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        denied = result.values.any { !it }
        if (!denied) Team.link.startScan()
    }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            Modifier
                .safeDrawingPadding()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onBack) { Text(stringResource(R.string.back)) }
                Text(stringResource(R.string.team_title), style = MaterialTheme.typography.titleLarge)
            }

            Section(stringResource(R.string.team_callsign)) {
                OutlinedTextField(
                    value = callsign,
                    onValueChange = Team::setCallsign,
                    singleLine = true,
                    isError = callsign.isNotEmpty() && !Pstk.isValidCallsign(callsign),
                    placeholder = { Text("JUAN") },
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters),
                    modifier = Modifier.fillMaxWidth(),
                )
                Hint(stringResource(R.string.team_callsign_help))
            }

            Section(stringResource(R.string.team_node)) {
                val status = when (phase) {
                    NodeLink.Phase.IDLE -> stringResource(R.string.node_idle)
                    NodeLink.Phase.SCANNING -> stringResource(R.string.node_scanning)
                    NodeLink.Phase.CONNECTING -> stringResource(R.string.node_connecting)
                    NodeLink.Phase.CONNECTED -> stringResource(R.string.node_connected, node.name ?: "", node.device ?: "")
                }
                Text(status)
                if (!Team.link.bluetoothOn) Hint(stringResource(R.string.node_bluetooth_off))
                if (denied) Hint(stringResource(R.string.node_permission_denied))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { askBluetooth.launch(bluetoothPermissions()) }, enabled = phase == NodeLink.Phase.IDLE) {
                        Text(stringResource(R.string.node_scan))
                    }
                    if (paired != null) {
                        OutlinedButton(onClick = Team::forget) { Text(stringResource(R.string.node_forget)) }
                    }
                }
                found.forEach { f ->
                    HorizontalDivider()
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(f.name)
                            Hint("${f.rssi} dBm")
                        }
                        Button(onClick = { Team.connect(f.address) }) { Text(stringResource(R.string.node_connect)) }
                    }
                }
            }

            if (phase == NodeLink.Phase.CONNECTED) {
                Section(stringResource(R.string.team_network)) {
                    when {
                        node.onNetwork -> {
                            Text(stringResource(R.string.net_on, node.net ?: ""), style = MaterialTheme.typography.titleMedium)
                            lastSent?.let { Hint(stringResource(R.string.net_last_sent, (now - it) / 1000)) }
                            OutlinedButton(onClick = Team::leave) { Text(stringResource(R.string.net_leave)) }
                        }
                        node.joinPending -> {
                            Text(stringResource(R.string.net_waiting))
                            Hint(stringResource(R.string.net_waiting_help))
                            OutlinedButton(onClick = Team::join) { Text(stringResource(R.string.net_ask_again)) }
                        }
                        else -> {
                            Text(stringResource(R.string.net_none))
                            if (node.rejected) Hint(stringResource(R.string.net_rejected))
                            Button(onClick = Team::join, enabled = Pstk.isValidCallsign(callsign)) {
                                Text(stringResource(R.string.net_join))
                            }
                            if (!Pstk.isValidCallsign(callsign)) Hint(stringResource(R.string.net_need_callsign))
                        }
                    }
                    node.lastError?.let { Hint(it) }
                }
            }

            Section(stringResource(R.string.team_members, members.size)) {
                base?.let { MemberRow(stringResource(R.string.map_base), it, now) }
                members.values.sortedBy { it.id }.forEach { MemberRow(it.id, it, now) }
                if (base == null && members.isEmpty()) Hint(stringResource(R.string.team_nobody))
            }
        }
    }
}

@Composable
private fun MemberRow(name: String, m: Team.Member, now: Long) {
    Row(Modifier.fillMaxWidth()) {
        Text(name, Modifier.weight(1f), fontFamily = FontFamily.Monospace)
        val signal = listOfNotNull(m.rssi?.let { "${it.toInt()} dBm" }, m.snr?.let { "%.1f dB".format(it) }).joinToString(" · ")
        Hint("$signal  ${stringResource(R.string.seconds_ago, (now - m.heardAt) / 1000)}")
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title.uppercase(), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            content()
        }
    }
}

@Composable
private fun Hint(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}
