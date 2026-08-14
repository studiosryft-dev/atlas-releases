package com.ryftlabs.atlas.data.download

import kotlinx.coroutines.flow.MutableStateFlow

/**
 * Process-wide "start/stop" switch for the download queue, separate from Wi-Fi-only waiting.
 * A plain in-memory flag rather than a DataStore setting — pausing is a session action, not a
 * persistent preference, and should reset to running on process restart.
 */
object DownloadQueueController {
    val isPaused = MutableStateFlow(false)

    fun pause() { isPaused.value = true }
    fun resume() { isPaused.value = false }
}
