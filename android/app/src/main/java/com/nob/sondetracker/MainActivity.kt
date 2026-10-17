package com.nob.sondetracker

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import com.nob.sondetracker.map.MapScreen
import com.nob.sondetracker.offline.OfflineMaps
import com.nob.sondetracker.team.Team
import com.nob.sondetracker.team.TeamScreen
import com.nob.sondetracker.ui.theme.SondeTrackerTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        Team.init(applicationContext)
        OfflineMaps.init(applicationContext)
        setContent {
            // Always dark: the map is dark and chases often happen at dawn.
            SondeTrackerTheme(darkTheme = true) {
                var showTeam by rememberSaveable { mutableStateOf(false) }
                // The map stays underneath, so it keeps its place while the team screen is open.
                Box {
                    MapScreen(onOpenTeam = { showTeam = true })
                    if (showTeam) TeamScreen(onBack = { showTeam = false })
                }
            }
        }
    }
}
