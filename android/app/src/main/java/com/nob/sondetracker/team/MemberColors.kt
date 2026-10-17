package com.nob.sondetracker.team

/**
 * One color per team member from their node's chip id: the same hash and palette as the web
 * app (webapp/src/companion/colors.ts), so everyone has the same color on every screen.
 * "A1B2C3" must give "#9b8cff", as the web app's test pins.
 */
object MemberColors {
    val PALETTE = listOf("#9b8cff", "#ffb347", "#4dd0e1", "#ff6f91", "#a5d65a", "#f4d35e", "#c792ea", "#5cc8ff")

    fun of(id: String): String {
        var h = 0L
        for (c in id) h = (h * 31 + c.code) and 0xFFFFFFFFL
        return PALETTE[(h % PALETTE.size).toInt()]
    }
}
