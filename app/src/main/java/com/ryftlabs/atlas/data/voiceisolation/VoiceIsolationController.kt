package com.ryftlabs.atlas.data.voiceisolation

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.Serializable

@Serializable
data class VoiceIsolationJobState(
    val sourceTrackId: String,
    val percent: Int,
    val status: String, // RUNNING, DONE, FAILED
    val errorMessage: String? = null,
    val resultTrackIds: List<String> = emptyList(),
)

/** Bridges progress from [VoiceIsolationService] (a plain Android Service, no Activity/bridge
 *  reference) back to [com.ryftlabs.atlas.bridge.WebAppBridge], which observes this and pushes
 *  to JS — same in-memory-singleton pattern as DownloadQueueController. */
object VoiceIsolationController {
    val jobState = MutableStateFlow<VoiceIsolationJobState?>(null)
}
