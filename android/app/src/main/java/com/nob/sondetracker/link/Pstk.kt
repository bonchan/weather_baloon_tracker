package com.nob.sondetracker.link

import java.util.Locale

/**
 * The Sonde Tracker link: `$PSTK,<type>,<fields...>*hh` sentences, the same the firmware and the
 * web app speak (spec: arduino/common/SondeTrackerLink.h). The phone talks them over Bluetooth
 * to its Heltec node, which carries them over LoRa to the team.
 */
object Pstk {
    const val NO_NET = "----"
    const val SRC_BASE = "BASE"
    const val FIX_OK = 2

    sealed interface Msg

    /** The node's identity: its team network ([NO_NET] when none) and chip id. */
    data class Id(val kind: String, val name: String, val firmware: String, val net: String?, val device: String?) : Msg

    data class Pos(
        val src: String,
        val fix: Int,
        val lat: Double,
        val lon: Double,
        /** m above sea level */
        val alt: Double?,
        /** m/s */
        val speed: Double?,
        /** degrees true */
        val course: Double?,
        /** Unix s */
        val utc: Long?,
    ) : Msg

    data class Sonde(
        val serial: String,
        val frame: Int,
        val lat: Double,
        val lon: Double,
        val alt: Double,
        val climb: Double?,
        val speed: Double?,
        val course: Double?,
        val utc: Long?,
    ) : Msg

    /** Something the node heard over LoRa on its network. */
    data class Heard(val rssi: Double?, val snr: Double?, val inner: Msg?) : Msg

    /** The base station let us in: we are on network [net]. */
    data class Bound(val net: String) : Msg

    data object Rejected : Msg

    data class Log(val text: String, val error: Boolean) : Msg

    fun checksum(body: String): String {
        var sum = 0
        for (c in body) sum = sum xor c.code
        return String.format(Locale.US, "%02X", sum and 0xFF)
    }

    /** A whole sentence: `$body*hh`. */
    fun sentence(body: String) = "\$$body*${checksum(body)}"

    /** The text between '$' and '*' when the checksum matches, else null. */
    fun checkedBody(line: String): String? {
        val start = line.lastIndexOf('$')
        val star = line.lastIndexOf('*')
        if (start < 0 || star < start || star + 3 > line.length) return null
        val body = line.substring(start + 1, star)
        return if (line.substring(star + 1, star + 3).equals(checksum(body), ignoreCase = true)) body else null
    }

    fun parse(line: String): Msg? = checkedBody(line.trim())?.let(::parseBody)

    /** A sentence body without '$' and checksum, e.g. "PSTK,POS,JUAN,...". */
    fun parseBody(body: String): Msg? {
        if (!body.startsWith("PSTK,")) return null
        val f = body.split(',')
        fun num(i: Int) = f.getOrNull(i)?.takeIf { it.isNotEmpty() }?.toDoubleOrNull()
        return when (f.getOrNull(1)) {
            "ID" -> Id(
                kind = f.getOrElse(3) { "" },
                name = f.getOrElse(4) { "" },
                firmware = f.getOrElse(5) { "" },
                net = f.getOrNull(6)?.takeIf { it.isNotEmpty() },
                device = f.getOrNull(7)?.takeIf { it.isNotEmpty() },
            )
            "POS" -> {
                val src = f.getOrNull(2)?.takeIf { it.isNotEmpty() } ?: return null
                val lat = num(6) ?: return null
                val lon = num(7) ?: return null
                Pos(src, num(3)?.toInt() ?: 0, lat, lon, num(8), num(10), num(11), num(12)?.toLong())
            }
            "SONDE" -> {
                val serial = f.getOrNull(2)?.takeIf { it.isNotEmpty() } ?: return null
                Sonde(
                    serial = serial,
                    frame = num(3)?.toInt() ?: 0,
                    lat = num(4) ?: return null,
                    lon = num(5) ?: return null,
                    alt = num(6) ?: return null,
                    climb = num(7),
                    speed = num(8),
                    course = num(9),
                    utc = num(10)?.toLong(),
                )
            }
            "HEARD" -> Heard(num(2), num(3), parseBody(f.drop(4).joinToString(",")))
            "BOUND" -> f.getOrNull(2)?.takeIf { it.length == 4 }?.let(::Bound)
            "REJECTED" -> Rejected
            "LOG" -> Log(body.removePrefix("PSTK,LOG,"), error = false)
            "ERR" -> Log(body.removePrefix("PSTK,ERR,"), error = true)
            else -> null
        }
    }

    private fun field(v: Double?, digits: Int) = v?.let { String.format(Locale.US, "%.${digits}f", it) } ?: ""

    /** POS body for my own position. */
    fun posBody(src: String, lat: Double, lon: Double, alt: Double?, speed: Double?, course: Double?, utc: Long): String =
        listOf(
            "PSTK", "POS", src, FIX_OK.toString(), "", "",
            String.format(Locale.US, "%.6f", lat), String.format(Locale.US, "%.6f", lon),
            field(alt, 1), "", field(speed, 2), field(course, 1), utc.toString(),
        ).joinToString(",")

    /** Uppercase letters, digits and '-', up to 8: short enough to keep LoRa packets small. */
    fun normalizeCallsign(input: String) = input.uppercase(Locale.ROOT).filter { it in 'A'..'Z' || it in '0'..'9' || it == '-' }.take(8)

    fun isValidCallsign(id: String) = id.length >= 2 && id == normalizeCallsign(id) && id != SRC_BASE && id != "SELF"
}
