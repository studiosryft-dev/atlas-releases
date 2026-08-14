package com.embyrlabs.atlas.playback

import android.util.Log
import com.embyrlabs.atlas.data.db.TrackEntity
import com.embyrlabs.atlas.data.download.DownloadEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

@Serializable
data class QueueState(
    val queue: List<TrackEntity> = emptyList(),
    /** Oldest-played first, most-recently-played last — matches the Queue page's "top is the
     *  first song played, bottom is the last" description. */
    val history: List<TrackEntity> = emptyList(),
    val currentIndex: Int = -1,
)

/**
 * Session-only playback queue + history, sitting on top of [PlayerController]'s real Media3
 * timeline. In-memory only by design (resets on app relaunch) — matches "lasts for the entire
 * session... until you physically close the app" rather than a persisted Room table.
 *
 * History is derived by watching for track-id changes on [PlayerController.state]: whenever the
 * currently-playing track changes, whatever was playing *before* that change gets appended to
 * history. This catches every path a track can change (manual skip, auto-advance, jumping to a
 * different queue index), not just explicit user actions.
 */
class QueueManager(
    private val playerController: PlayerController,
    scope: CoroutineScope,
    private val downloadEngine: DownloadEngine,
) {

    private val json = Json { encodeDefaults = true }
    private val _queueState = MutableStateFlow(QueueState())
    val queueFlow: StateFlow<QueueState> = _queueState.asStateFlow()

    private var lastTrackId: String? = null

    init {
        playerController.state.onEach { state ->
            if (state.currentTrackId != null && state.currentTrackId != lastTrackId) {
                val previousId = lastTrackId
                if (previousId != null) {
                    playerController.currentQueueSnapshot().firstOrNull { it.id == previousId }?.let { previousTrack ->
                        _queueState.value = _queueState.value.copy(history = _queueState.value.history + previousTrack)
                    }
                }
                lastTrackId = state.currentTrackId
            }
            _queueState.value = _queueState.value.copy(
                queue = playerController.currentQueueSnapshot(),
                currentIndex = state.currentIndex,
            )
        }.launchIn(scope)
    }

    suspend fun playQueue(tracks: List<TrackEntity>, startIndex: Int, playlistContextId: String?) {
        val ready = ensureDownloaded(tracks)
        playerController.playQueue(ready, startIndex, playlistContextId)
        _queueState.value = _queueState.value.copy(queue = ready, currentIndex = startIndex)
    }

    suspend fun playShuffled(tracks: List<TrackEntity>, playlistContextId: String?) {
        if (tracks.isEmpty()) return
        val ready = ensureDownloaded(tracks).shuffled()
        playerController.playQueue(ready, 0, playlistContextId)
        _queueState.value = _queueState.value.copy(queue = ready, currentIndex = 0)
    }

    /** Idle Compression can leave a Library track's local file removed (see TrackEntity.
     *  isDownloaded) while the track itself stays fully visible/playable-looking in every list —
     *  this is the single choke point every "start playing this set of tracks" path (Library
     *  Play/Shuffle, a Playlist's Play/Shuffle, re-adding from Queue history) runs through, so
     *  it's also the one place that needs to notice and re-download before handing tracks to
     *  ExoPlayer. Awaited, not fire-and-forget — playback can't actually start on a track with
     *  no file yet, so the Bridge.call the UI is waiting on simply takes a little longer for a
     *  compressed track rather than the app silently trying (and failing) to play nothing. A
     *  track whose re-download fails is left out of the resulting queue entirely rather than
     *  aborting the whole play action for every other track in the set. */
    private suspend fun ensureDownloaded(tracks: List<TrackEntity>): List<TrackEntity> =
        tracks.mapNotNull { track ->
            if (track.isDownloaded || track.derivedKind != null) track
            else runCatching { downloadEngine.redownloadInPlace(track) }
                .onFailure { Log.w("QueueManager", "Re-download failed for ${track.title}", it) }
                .getOrNull()
        }

    fun playNext() = playerController.skipNext()

    fun playIndex(index: Int) = playerController.seekToMediaItem(index)

    fun reorder(fromIndex: Int, toIndex: Int) {
        playerController.moveMediaItem(fromIndex, toIndex)
        _queueState.value = _queueState.value.copy(queue = playerController.currentQueueSnapshot())
    }

    /** Removes a single track from the live queue — Queue page's swipe-left/right-to-remove
     *  gesture. Does not touch the Library; the track is only dropped from this session's queue. */
    fun removeAt(index: Int) {
        playerController.removeMediaItem(index)
        _queueState.value = _queueState.value.copy(queue = playerController.currentQueueSnapshot())
    }

    /** Clears the queue and stops playback — Queue page's "Clear Queue" button. */
    fun clear() {
        playerController.clearQueue()
        _queueState.value = _queueState.value.copy(queue = emptyList(), currentIndex = -1)
    }

    /** Re-adds a played track from history onto the end of the live queue. */
    suspend fun reAddFromHistory(historyIndex: Int) {
        val track = _queueState.value.history.getOrNull(historyIndex) ?: return
        val ready = ensureDownloaded(listOf(track)).firstOrNull() ?: return
        playerController.addToQueueEnd(ready)
        _queueState.value = _queueState.value.copy(queue = playerController.currentQueueSnapshot())
    }

    fun encodeQueueState(): String = json.encodeToString(_queueState.value)
}
