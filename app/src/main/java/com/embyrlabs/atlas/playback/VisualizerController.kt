package com.embyrlabs.atlas.playback

import android.media.audiofx.Visualizer
import kotlin.math.sqrt

/**
 * Real audio-reactive data for Now Playing's visualizer — FFT magnitude captured from the
 * actual ExoPlayer audio session via [android.media.audiofx.Visualizer] (the same "attach an
 * effect to the current audio session id" pattern [EqualizerController] already uses, not a
 * fake looping animation). A singleton (see [instance]) rather than owned by [PlaybackService]
 * directly, since [com.embyrlabs.atlas.bridge.WebAppBridge] — which runs in the same process but
 * isn't the service — is what JS actually starts/stops this from (only while Now Playing is open
 * and something is actually playing, per the perf requirement below).
 *
 * Capture only runs while something has called [start] — [PlaybackService] feeding session-id
 * changes into [onAudioSessionChanged] is cheap/always-on, but the expensive part (the FFT
 * listener itself) only exists between [start] and [stop]. [minIntervalMs] throttles how often
 * data actually gets pushed to JS regardless of the native capture rate, and is doubled under
 * Phone Heat Optimization (see WebAppBridge's visualizer.start handler) rather than running a
 * second, separate low-power implementation.
 */
class VisualizerController {
    private var visualizer: Visualizer? = null
    private var sessionId = -1
    private var onData: ((FloatArray) -> Unit)? = null
    private var minIntervalMs = 66L
    private var lastPushMs = 0L

    fun onAudioSessionChanged(newSessionId: Int) {
        if (newSessionId == sessionId) return
        sessionId = newSessionId
        if (onData != null) startInternal() // still wanted — just needs to re-attach to the new session
    }

    fun start(minIntervalMs: Long, callback: (FloatArray) -> Unit) {
        onData = callback
        this.minIntervalMs = minIntervalMs
        startInternal()
    }

    fun stop() {
        onData = null
        stopInternal()
    }

    private fun startInternal() {
        stopInternal()
        val sid = sessionId
        if (sid <= 0 || onData == null) return
        runCatching {
            visualizer = Visualizer(sid).apply {
                val range = Visualizer.getCaptureSizeRange()
                captureSize = range[1].coerceAtMost(512).coerceAtLeast(range[0])
                setDataCaptureListener(
                    object : Visualizer.OnDataCaptureListener {
                        override fun onWaveFormDataCapture(v: Visualizer?, waveform: ByteArray?, samplingRate: Int) {}
                        override fun onFftDataCapture(v: Visualizer?, fft: ByteArray?, samplingRate: Int) {
                            fft ?: return
                            val now = System.currentTimeMillis()
                            if (now - lastPushMs < minIntervalMs) return
                            lastPushMs = now
                            onData?.invoke(bucketize(fft))
                        }
                    },
                    Visualizer.getMaxCaptureRate(),
                    false,
                    true,
                )
                enabled = true
            }
        }
    }

    private fun stopInternal() {
        runCatching { visualizer?.enabled = false }
        runCatching { visualizer?.release() }
        visualizer = null
    }

    /** Android's FFT byte layout: [dc, nyquist, re1, im1, re2, im2, ...]. Averages magnitude
     *  into a fixed number of bars (low bins first — bass/mid content dominates what actually
     *  reads as "the beat" visually) and normalizes roughly into 0..1. */
    private fun bucketize(fft: ByteArray, bars: Int = 24): FloatArray {
        val n = (fft.size - 2) / 2
        val out = FloatArray(bars)
        if (n <= 0) return out
        val perBar = (n / bars).coerceAtLeast(1)
        for (b in 0 until bars) {
            var sum = 0.0
            var count = 0
            for (i in 0 until perBar) {
                val idx = b * perBar + i
                if (idx >= n) break
                val re = fft[2 + idx * 2].toInt()
                val im = fft[2 + idx * 2 + 1].toInt()
                sum += sqrt((re * re + im * im).toDouble())
                count++
            }
            out[b] = if (count > 0) (sum / count / 110.0).coerceIn(0.0, 1.0).toFloat() else 0f
        }
        return out
    }

    companion object {
        val instance = VisualizerController()
    }
}
