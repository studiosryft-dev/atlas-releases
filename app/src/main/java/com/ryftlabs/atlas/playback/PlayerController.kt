package com.ryftlabs.atlas.playback

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.ryftlabs.atlas.data.db.TrackEntity
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
    /** 0 = off (default — nothing repeats), 1 = "Repeat Once" (every track plays twice before the
     *  queue advances), 2 = "Repeat Twice" (every track plays three times), 3 = "Loop" (the
     *  current track repeats forever, queue never advances). Toggle buttons in the UI, not a
     *  radio group — tapping the already-active one sends mode back to 0. See
     *  [PlayerController.setRepeatMode] for why 1/2 are hand-rolled instead of an ExoPlayer
     *  native repeat mode (there isn't one for "repeat exactly N times" — only
     *  off/one-forever/whole-playlist). */
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

    // Counts REPEAT_MODE_ONE loops of the current item against Repeat Once/Twice's target (see
    // attachListener's onMediaItemTransition) — reset to 0 on every item transition, so it's
    // always scoped to whatever's playing right now, not any specific track id.
    private var repeatReplaysDone: Int = 0

    /**
     * A genuine (if intermittent) cause of "the mini player/Now Playing button gets stuck showing
     * Play while music keeps playing, and the lock-screen/notification widget stops updating or
     * disappears" — PlaybackService is a foreground service, which protects it from *routine*
     * memory-pressure kills, but not from aggressive OEM battery-optimization task killers
     * (Xiaomi/OnePlus/Samsung and others are notorious for this specifically with background
     * media services) or a genuine low-memory kill under real pressure. Without a
     * MediaController.Listener, a dropped connection like that was previously silent: `controller`
     * kept pointing at a MediaController that would never receive another callback, freezing
     * `_state` at whatever it last was — forever, from the UI's point of view, until the user
     * force-closed and reopened the app. onDisconnected now triggers an automatic reconnect
     * attempt instead, so the app self-heals (a fresh MediaController, a fresh notification) the
     * next time anything asks it to.
     */
    fun connect(onReady: () -> Unit = {}) {
        val sessionToken = SessionToken(context, ComponentName(context, PlaybackService::class.java))
        val builder = MediaController.Builder(context, sessionToken)
            .setListener(object : MediaController.Listener {
                override fun onDisconnected(controller: MediaController) {
                    this@PlayerController.controller = null
                    connect(onReady)
                }
            })
        val future = builder.buildAsync()
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

            /** isPlaying is included here too, not just in the dedicated onIsPlayingChanged
             *  below — self-healing against the "stuck showing Play while it's actually playing"
             *  bug. onEvents fires on essentially every player event batch (way more often than
             *  just play/pause toggles), so even if some unusual command sequence — a crossfade
             *  cutover, a repeat-mode loop, a rapid pause/resume — ever caused a single
             *  onIsPlayingChanged call to be missed or misordered, the very next tick re-reads
             *  the player's real, current isPlaying and corrects it, rather than the UI staying
             *  wrong indefinitely until some future play/pause event happens to fire correctly. */
            override fun onEvents(player: Player, events: Player.Events) {
                _state.value = _state.value.copy(
                    isPlaying = player.isPlaying,
                    positionMs = player.currentPosition.coerceAtLeast(0),
                    durationMs = player.duration.coerceAtLeast(0),
                )
            }

            /** Repeat Once/Twice/Loop all run on real ExoPlayer REPEAT_MODE_ONE now — the
             *  previous design left the player's own repeatMode at OFF for modes 1/2 and instead
             *  waited for a genuine DISCONTINUITY_REASON_AUTO_TRANSITION to hijack, but ExoPlayer
             *  only ever fires that when there's a real *next* item to auto-advance to. On the
             *  last (or only) track in the queue it just stops instead — no transition event of
             *  any kind — so the repeat logic silently never triggered at all for exactly the
             *  case a listener is most likely to want it (finishing out the queue, or a single
             *  Library track). REPEAT_MODE_ONE has no such requirement; it loops the current item
             *  regardless of what else is (or isn't) queued after it, and reports each loop via
             *  onMediaItemTransition's own REPEAT reason — which is what this now counts against
             *  the target replay count instead. */
            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                val mode = _state.value.repeatMode
                when (reason) {
                    Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT -> {
                        // REPEAT_MODE_ONE just looped the current item back to its own start.
                        // Mode 3 (Loop) needs nothing further — keep looping forever. Modes 1/2
                        // count this loop against their target; once used up, drop the *player's*
                        // repeatMode back to OFF so the item's next natural end actually advances
                        // the queue instead of looping yet again.
                        if (mode == 1 || mode == 2) {
                            repeatReplaysDone++
                            if (repeatReplaysDone >= mode) controller.repeatMode = Player.REPEAT_MODE_OFF
                        }
                    }
                    Player.MEDIA_ITEM_TRANSITION_REASON_AUTO,
                    Player.MEDIA_ITEM_TRANSITION_REASON_SEEK -> {
                        // Landed on a (possibly new) item — re-arm for whatever mode is currently
                        // selected, fresh replay budget. Covers a genuine auto-advance, a manual
                        // skip/previous, and the crossfade cutover (PlayerController.seekTo/
                        // CrossfadeController's own primary.seekTo) alike.
                        repeatReplaysDone = 0
                        controller.repeatMode = if (mode in 1..3) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
                    }
                    else -> Unit
                }
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

    /** 0 = off, 1 = Repeat Once, 2 = Repeat Twice, 3 = Loop. All three non-zero modes run on real
     *  ExoPlayer REPEAT_MODE_ONE (see attachListener's onMediaItemTransition for how 1/2 count
     *  loops and drop back to OFF once their budget's used, vs. 3 which never does). */
    fun setRepeatMode(mode: Int) {
        _state.value = _state.value.copy(repeatMode = mode)
        repeatReplaysDone = 0 // fresh replay budget for whatever's playing right now
        controller?.repeatMode = if (mode in 1..3) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
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
