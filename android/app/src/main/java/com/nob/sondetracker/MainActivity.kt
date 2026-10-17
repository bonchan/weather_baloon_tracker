package com.nob.sondetracker

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.nob.sondetracker.map.MapScreen
import com.nob.sondetracker.ui.theme.SondeTrackerTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            // Always dark: the map is dark and chases often happen at dawn.
            SondeTrackerTheme(darkTheme = true) {
                MapScreen()
            }
        }
    }
}
