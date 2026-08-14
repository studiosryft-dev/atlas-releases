package com.embyrlabs.atlas.playback

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.embyrlabs.atlas.data.db.TrackEntity
import com.google.common.util.concurrent.MoreExecutors
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File

data class PlaybackUiState(
    val currentTrackId: String? = null,
    val currentIndex: Int = -1,
    val title: String? = null,
    val artist: String? = null,
    val artworkPath: String? = null,
    val qualityLabel: String? = null,
    val isPlaying: Boolean = false,
    val positionMs: Long = 0L,
    val durationMs: Long = 0L,
    /** 0 = off, 1 = repeat the current track exactly once then continue, 2 = repeat the current
     *  track indefinitely. See [PlayerController.setRepeatMode] for why "once" is hand-rolled
     *  instead of using an ExoPlayer native repeat mode (there isn't one for "repeat exactly
     *  once" — only off/one-forever/whole-playlist). */
    val repeatMode: Int = 0,
)

/**
 * Wraps a Media3 [MediaController] connected to [PlaybackService], translating it into a
 * StateFlow the Compose UI can collect. One instance is created in MainActivity and threaded
 * through the screens that need it (Library's Play/Shuffle, the mini player, Now Playing).
 */
class PlayerController(private val context: Context) {

    private var controller: MediaController? = null

    private val _state = MutableStateFlow(PlaybackUiState())
    val state: StateFlow<PlaybackUiState> = _state.asStateFlow()

    private var currentQueue: List<TrackEntity> = emptyList()
    private var currentPlaylistContextId: String? = null

    // "Repeat Once" (mode 1) is tracked ourselves rather than via any ExoPlayer native repeat
    // mode — Media3 only offers off / repeat-this-item-forever / repeat-whole-playlist, none of
    // which is "replay this one track exactly one extra time, then carry on." Keyed by mediaId
    // (not index — indices shift under reordering) so a track that's already had its one replay
    // doesn't loop forever if it happens to end naturally a second time before the user moves on.
    private var repeatOnceConsumedForId: String? = null

    fun connect(onReady: () -> Unit = {}) {
        val sessionToken = SessionToken(context, ComponentName(context, PlaybackService::class.java))
        val future = MediaController.Builder(context, sessionToken).buildAsync()
        future.addListener({
            controller = future.get().also { attachListener(it) }
            onReady()
        }, MoreExecutors.directExecutor())
    }

    fun release() {
        controller?.release()
        controller = null
    }

    private fun attachListener(controller: MediaController) {
        controller.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                _state.value = _state.value.copy(isPlaying = isPlaying)
            }

            override fun onMediaMetadataChanged(mediaMetadata: MediaMetadata) {
                val index = controller.currentMediaItemIndex
                val track = currentQueue.getOrNull(index)
                _state.value = _state.value.copy(
                    currentTrackId = track?.id,
                    currentIndex = index,
                    title = mediaMetadata.title?.toString() ?: track?.title,
                    artist = mediaMetadata.artist?.toString() ?: track?.artist,
                    artworkPath = track?.artworkPath,
                    qualityLabel = track?.qualityLabel,
                    durationMs = controller.duration.coerceAtLeast(0),
                )
            }

            override fun onEvents(player: Player, events: Player.Events) {
                _state.value = _state.value.copy(
                    positionMs = player.currentPosition.coerceAtLeast(0),
                    durationMs = player.duration.coerceAtLeast(0),
                )
            }

            /** The hook "Repeat Once" runs on — [reason] is AUTO_TRANSITION only when a track
             *  ended naturally and the player advanced on its own (never for a manual skip/seek/
             *  previous), which is exactly the one case this feature cares about. */
            override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
                if (reason != Player.DISCONTINUITY_REASON_AUTO_TRANSITION) return
                if (_state.value.repeatMode != 1) return
                val finishedId = oldPosition.mediaItem?.mediaId ?: return
                if (finishedId == repeatOnceConsumedForId) return // already had its one replay
                repeatOnceConsumedForId = finishedId
                controller.seekTo(oldPosition.mediaItemIndex, 0L)
            }
        })
    }

    /**
     * Plays [tracks] starting at [startIndex], top-to-bottom, in the order given.
     * [playlistContextId] is threaded into each MediaItem so the playback-side EqualizerController
     * knows whether a per-playlist EQ override should apply (null when playing from Library —
     * i.e. no playlist context, only track-level or global EQ can apply).
     */
    fun playQueue(tracks: List<TrackEntity>, startIndex: Int = 0, playlistContextId: String? = null) {
        val c = controller ?: return
        currentQueue = tracks
        currentPlaylistContextId = playlistContextId
        c.setMediaItems(tracks.map { it.toMediaItem(playlistContextId) }, startIndex, 0L)
        c.prepare()
        c.play()
    }

    /** Shuffles [tracks] into a fresh random order every time it's called, then plays it. */
    fun playShuffled(tracks: List<TrackEntity>, playlistContextId: String? = null) {
        if (tracks.isEmpty()) return
        playQueue(tracks.shuffled(), 0, playlistContextId)
    }

    fun togglePlayPause() {
        val c = controller ?: return
        if (c.isPlaying) c.pause() else c.play()
    }

    fun pause() = controller?.pause()

    /** 0 = off, 1 = repeat current track once, 2 = repeat current track indefinitely. Mode 2
     *  delegates straight to ExoPlayer's own REPEAT_MODE_ONE; mode 1 is hand-rolled (see
     *  onPositionDiscontinuity above), so the underlying player itself stays REPEAT_MODE_OFF for
     *  both 0 and 1 — only our own state field distinguishes them. */
    fun setRepeatMode(mode: Int) {
        _state.value = _state.value.copy(repeatMode = mode)
        repeatOnceConsumedForId = null // switching modes re-arms a possible replay for whatever's playing now
        controller?.repeatMode = if (mode == 2) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
    }

    fun skipNext() = controller?.seekToNextMediaItem()
    fun skipPrevious() = controller?.seekToPreviousMediaItem()
    fun seekTo(positionMs: Long) = controller?.seekTo(positionMs)

    /** Reorders the live playback timeline without interrupting playback — used by the Queue
     *  page's drag-reorder. [currentQueue] is kept in sync so track-id/artwork lookups on the
     *  next metadata/index change still resolve correctly. */
    fun moveMediaItem(from: Int, to: Int) {
        controller?.moveMediaItem(from, to)
        if (from in currentQueue.indices && to in currentQueue.indices) {
            currentQueue = currentQueue.toMutableList().apply { add(to, removeAt(from)) }
        }
    }

    fun clearQueue() {
        controller?.clearMediaItems()
        currentQueue = emptyList()
    }

    /** Removes a single track from the live timeline without stopping playback — Queue page's
     *  swipe-to-remove gesture (either direction just removes the swiped track from the queue,
     *  not from the Library). */
    fun removeMediaItem(index: Int) {
        controller?.removeMediaItem(index)
        if (index in currentQueue.indices) {
            currentQueue = currentQueue.toMutableList().apply { removeAt(index) }
        }
    }

    fun seekToMediaItem(index: Int) = controller?.seekTo(index, 0L)

    /** Appends one track to the end of the live queue (Queue page's "Re-add from history"). */
    fun addToQueueEnd(track: TrackEntity, playlistContextId: String? = null) {
        controller?.addMediaItem(track.toMediaItem(playlistContextId))
        currentQueue = currentQueue + track
    }

    /** Current queue order — read by QueueManager to keep its own state (search highlighting,
     *  drag-reorder preview) in sync with what's actually playing. */
    fun currentQueueSnapshot(): List<TrackEntity> = currentQueue

    private fun TrackEntity.toMediaItem(playlistContextId: String?): MediaItem {
        val artworkUri = artworkPath?.takeIf { it.isNotBlank() }?.let { Uri.fromFile(File(it)) }
        val extras = playlistContextId?.let { Bundle().apply { putString(PlaybackService.EXTRA_PLAYLIST_ID, it) } }
        return MediaItem.Builder()
            .setMediaId(id)
            .setUri(Uri.fromFile(File(localFilePath)))
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(title)
                    .setArtist(artist)
                    .apply {
                        if (artworkUri != null) setArtworkUri(artworkUri)
                        if (extras != null) setExtras(extras)
                    }
                    .build()
            )
            .build()
    }
}
