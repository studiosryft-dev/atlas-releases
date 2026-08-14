package com.ryftlabs.atlas.data.equalizer

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlin.math.log10

data class EqPoint(val freqHz: Float, val gainDb: Float)
data class EqPreset(val id: String, val label: String, val points: List<EqPoint>)

/**
 * Canonical curves as (frequency, gain) control points, independent of any specific device's
 * actual band layout — [interpolateGainDb] maps a curve onto whatever bands the connected
 * device's `android.media.audiofx.Equalizer` reports. Control points span 20Hz-20kHz (full
 * audible range) so interpolation never has to extrapolate past an endpoint.
 */
val EQ_PRESETS: List<EqPreset> = listOf(
    EqPreset("flat", "Flat", flatCurve()),
    EqPreset(
        "acoustic", "Acoustic",
        curve(20f to 2f, 100f to 3f, 500f to 1f, 2000f to 0f, 6000f to 2f, 20000f to 3f),
    ),
    EqPreset(
        "bass_booster", "Bass Booster",
        curve(20f to 8f, 60f to 7f, 250f to 3f, 1000f to 0f, 4000f to 0f, 20000f to 0f),
    ),
    EqPreset(
        "bass_reducer", "Bass Reducer",
        curve(20f to -8f, 60f to -6f, 250f to -2f, 1000f to 0f, 4000f to 0f, 20000f to 0f),
    ),
    EqPreset(
        "classical", "Classical",
        curve(20f to 4f, 250f to 2f, 1000f to -1f, 4000f to -1f, 8000f to 2f, 20000f to 4f),
    ),
    EqPreset(
        "instrumental", "Instrumental",
        curve(20f to 1f, 250f to 0f, 1000f to 1f, 4000f to 3f, 8000f to 3f, 20000f to 2f),
    ),
    EqPreset(
        "vocal_booster", "Vocal Booster",
        curve(20f to -3f, 250f to -1f, 1000f to 3f, 3000f to 4f, 6000f to 2f, 20000f to -1f),
    ),
    EqPreset(
        "vocal_reducer", "Vocal Reducer",
        curve(20f to 2f, 250f to 1f, 1000f to -3f, 3000f to -4f, 6000f to -2f, 20000f to 1f),
    ),
    EqPreset(
        // "Harmonic" here means the overtone-rich upper-mid/presence range (~2-6kHz) that
        // carries a track's harmonic detail/warmth — boosting it adds perceived richness
        // without the harshness of a straight treble boost.
        "harmonic_booster", "Harmonic Boost",
        curve(20f to 0f, 250f to 0f, 1000f to 1f, 2500f to 5f, 5000f to 5f, 8000f to 2f, 20000f to 0f),
    ),
    EqPreset(
        "harmonic_reducer", "Harmonic Cut",
        curve(20f to 0f, 250f to 0f, 1000f to -1f, 2500f to -5f, 5000f to -5f, 8000f to -2f, 20000f to 0f),
    ),
)

fun presetById(id: String): EqPreset = EQ_PRESETS.firstOrNull { it.id == id } ?: EQ_PRESETS.first()

/** The 5 fixed reference frequencies the custom-curve UI always shows exactly 5 draggable
 *  points for, regardless of how many bands the connected device's real Equalizer reports —
 *  same "canonical curve, interpolated onto whatever bands exist" approach presets already
 *  use (see [interpolateGainDb]/[buildBandLevelsMillibel]), just with a curve the user can
 *  edit directly instead of a fixed named preset. Standard consumer 5-band layout: sub-bass,
 *  bass, mid, presence, treble. */
val CUSTOM_CURVE_FREQS_HZ = listOf(60f, 250f, 1000f, 4000f, 12000f)

private fun flatCurve(): List<EqPoint> = listOf(EqPoint(20f, 0f), EqPoint(20000f, 0f))

private fun curve(vararg points: Pair<Float, Float>): List<EqPoint> =
    points.map { EqPoint(it.first, it.second) }.sortedBy { it.freqHz }

/** Linear interpolation in log-frequency space (matches how humans perceive pitch/frequency
 *  spacing, and how EQ band centers are themselves spaced) between the two bracketing control
 *  points. Clamps to the nearest endpoint's gain outside the curve's own range. */
fun interpolateGainDb(points: List<EqPoint>, targetFreqHz: Float): Float {
    if (points.isEmpty()) return 0f
    if (points.size == 1) return points[0].gainDb

    val sorted = points.sortedBy { it.freqHz }
    if (targetFreqHz <= sorted.first().freqHz) return sorted.first().gainDb
    if (targetFreqHz >= sorted.last().freqHz) return sorted.last().gainDb

    val upperIndex = sorted.indexOfFirst { it.freqHz >= targetFreqHz }
    val lower = sorted[upperIndex - 1]
    val upper = sorted[upperIndex]

    if (upper.freqHz == lower.freqHz) return lower.gainDb

    val logLower = log10(lower.freqHz.toDouble())
    val logUpper = log10(upper.freqHz.toDouble())
    val logTarget = log10(targetFreqHz.toDouble())
    val t = ((logTarget - logLower) / (logUpper - logLower)).coerceIn(0.0, 1.0)

    return (lower.gainDb + t * (upper.gainDb - lower.gainDb)).toFloat()
}

/** Converts a preset (or arbitrary curve) into millibel band levels for the given device band
 *  center frequencies, clamped to the device's reported gain range. */
fun buildBandLevelsMillibel(points: List<EqPoint>, bandCenterFreqsHz: List<Int>, rangeMillibel: IntRange): List<Short> =
    bandCenterFreqsHz.map { freq ->
        val gainDb = interpolateGainDb(points, freq.toFloat())
        (gainDb * 100).toInt().coerceIn(rangeMillibel.first, rangeMillibel.last).toShort()
    }

// Custom-curve JSON codec: a plain array of 5 gainDb floats, one per CUSTOM_CURVE_FREQS_HZ
// entry in order. Used for both the global custom curve (SettingsRepository) and per-track/
// per-playlist custom curves (EqualizerOverrideEntity). Deliberately NOT band-index-keyed
// (that was the old format) — the custom-curve UI always shows exactly 5 fixed-frequency
// draggable points regardless of device band count, same "canonical curve interpolated onto
// real device bands" path as presets, via [customLevelsToPoints]/[buildBandLevelsMillibel].
private val eqJson = Json { ignoreUnknownKeys = true }

fun encodeCustomLevels(gainsDb: List<Float>): String = eqJson.encodeToString(gainsDb)

fun decodeCustomLevels(json: String): List<Float> =
    runCatching { eqJson.decodeFromString<List<Float>>(json) }
        .getOrNull()
        ?.takeIf { it.size == CUSTOM_CURVE_FREQS_HZ.size }
        ?: List(CUSTOM_CURVE_FREQS_HZ.size) { 0f }

fun customLevelsToPoints(gainsDb: List<Float>): List<EqPoint> =
    CUSTOM_CURVE_FREQS_HZ.zip(gainsDb) { freq, gain -> EqPoint(freq, gain) }
