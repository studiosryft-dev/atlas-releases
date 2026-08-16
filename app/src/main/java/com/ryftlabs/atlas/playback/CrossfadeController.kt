package com.ryftlabs.atlas.playback

import android.content.Context
import android.util.Log
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import com.ryftlabs.atlas.data.settings.SettingsRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

private const val TAG = "CrossfadeController"
private const val STEP_MS = 30L

/**
 * Equal-power crossfade (what Apple Music's own crossfade actually is — a fixed-duration volume
 * fade, not beat-matched/tempo-synced) layered on top of [PlayerController]'s single "primary"
 * ExoPlayer, without changing that player's architecture at all. QueueManager/PlayerController
 * still own the one real playlist/timeline exactly as before crossfade existed; this class is
 * purely additive.
 *
 * Mechanism, deliberately chosen to avoid swapping which player the MediaSession exposes
 * (Media3's `MediaSession.setPlayer` exists for this but hot-swapping the session's player is a
 * real behavioral risk to lock-screen controls/state — not worth it here):
 * 1. A short-lived *secondary* ExoPlayer (never exposed to the MediaSession, QueueManager, or
 *    the UI — entirely internal to this class) preloads the upcoming track and fades it in from
 *    volume 0 while the primary fades out from volume 1, using an equal-power curve
 *    (`cos`/`sin`, not linear — keeps perceived loudness constant through the transition instead
 *    of dipping in the middle the way a linear fade would).
 * 2. The instant the fade completes, the primary is *already silent* (volume ramped to 0), so
 *    calling its own native `seekToNextMediaItem()` — which restarts that MediaItem from
 *    position 0 — happens inaudibly. Volume is then restored to 1 on the primary and the
 *    secondary is torn down. The primary's playlist/index/history tracking all just see a
 *    completely normal native track transition, because that's exactly what it is.
 */
class CrossfadeController(
    private val context: Context,
    private val primary: ExoPlayer,
    private val settingsRepository: SettingsRepository,
    private val scope: CoroutineScope,
) {
    private var secondary: ExoPlayer? = null
    private var crossfadeJob: Job? = null
    private var pollJob: Job? = null
    private var crossfadeSeconds: Float = 0f
    private var lastCrossfadedItemIndex = -1

    // Right after seekToNextMediaItem() lands on the new item, ExoPlayer's own duration/position
    // reporting can take a beat to fully settle onto that item's real metadata rather than the
    // just-departed item's tail end. maybeStartCrossfade() reading a stale/transitional duration
    // in that window was passing its own "remaining <= crossfadeSeconds" guard immediately —
    // this is the actual cause of the reported bug (7s crossfade duration set -> the new track
    // plays for a few seconds, then gets crossfaded/skipped into *again* almost immediately, as
    // if it were already near its own end). A short cooldown after every transition, regardless
    // of the exact internal timing quirk, keeps the poll loop from evaluating a track it just
    // switched onto until that track's own state has had a moment to settle.
    private var lastTransitionAtMs = 0L
    private val TRANSITION_COOLDOWN_MS = 1500L

    // The actual root cause of "track 2 only plays for the crossfade duration, then jumps
    // straight to track 3": primary is deliberately never paused during a crossfade (it has to
    // keep actually playing for its own fade-OUT to be audible), so its position keeps advancing
    // in real time throughout the whole fade window. maybeStartCrossfade's "remaining time"
    // estimate only has to be slightly optimistic (or the track slightly short) for primary to
    // hit track 1's own natural end *during* the fade and auto-advance itself onto track 2 —
    // entirely independently of, and before, this class's own end-of-fade seekToNextMediaItem()
    // call. That call used to fire unconditionally, so when primary had already self-advanced it
    // ended up seeking from track 2 to track 3 instead of from track 1 to track 2 — landing on
    // track 3 at full volume the instant the fade loop ended, while what the listener actually
    // heard of track 2 was only ever secondary's copy, cut short right as the fade finished.
    private var primaryAutoAdvancedDuringFade = false

    fun start() {
        settingsRepository.crossfadeSeconds
            .onEach { crossfadeSeconds = it }
            .launchIn(scope)

        // Also resets the cooldown on a transition that *wasn't* triggered by this class (a
        // manual skip, a track ending naturally with crossfade off at the time, etc.) — the
        // stale-duration-right-after-a-transition risk maybeStartCrossfade's cooldown guards
        // against isn't specific to crossfade-initiated transitions.
        primary.addListener(object : Player.Listener {
            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                lastTransitionAtMs = System.currentTimeMillis()
                if (crossfadeJob?.isActive == true && reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO) {
                    primaryAutoAdvancedDuringFade = true
                }
            }
        })

        pollJob = scope.launchPollLoop()
    }

    // Every touch of `primary` (isPlaying/duration/currentPosition/hasNextMediaItem/etc.) below
    // is a real ExoPlayer instance, and ExoPlayer throws IllegalStateException immediately if
    // accessed off the app's main thread — that's a fatal, process-killing crash, not a soft
    // failure. `scope` (PlaybackService's serviceScope) runs on Dispatchers.Default, so every
    // launch in this class that ever reads/writes `primary` or `secondary` must explicitly
    // switch to Dispatchers.Main.immediate rather than inherit that default.
    private fun CoroutineScope.launchPollLoop() = launch(Dispatchers.Main.immediate) {
        while (true) {
            delay(STEP_MS * 4) // poll a bit less often than the fade's own step rate
            maybeStartCrossfade()
        }
    }

    private fun maybeStartCrossfade() {
        if (crossfadeSeconds <= 0f) return
        if (crossfadeJob?.isActive == true) return
        if (System.currentTimeMillis() - lastTransitionAtMs < TRANSITION_COOLDOWN_MS) return
        if (!primary.isPlaying) return
        val duration = primary.duration
        if (duration <= 0) return
        val remaining = duration - primary.currentPosition
        if (remaining > crossfadeSeconds * 1000) return
        if (!primary.hasNextMediaItem()) return
        val nextIndex = primary.nextMediaItemIndex
        if (nextIndex == lastCrossfadedItemIndex) return // already handled this transition

        val nextItem = primary.getMediaItemAt(nextIndex)
        lastCrossfadedItemIndex = nextIndex
        crossfadeJob = scope.launch(Dispatchers.Main.immediate) {
            runCrossfade(nextIndex, nextItem)
        }
    }

    private suspend fun runCrossfade(nextIndex: Int, nextItem: MediaItem) {
        primaryAutoAdvancedDuringFade = false
        try {
            val sec = (ExoPlayer.Builder(context).build()).also { secondary = it }
            sec.setMediaItem(nextItem)
            sec.volume = 0f
            sec.prepare()
            sec.play()

            val totalMs = (crossfadeSeconds * 1000).toLong().coerceAtLeast(STEP_MS)
            var elapsed = 0L
            while (elapsed < totalMs) {
                val t = (elapsed.toFloat() / totalMs).coerceIn(0f, 1f)
                // Equal-power: cos^2(x) + sin^2(x) == 1, so combined perceived loudness stays
                // constant through the fade rather than dipping like a linear crossfade would.
                val angle = t * (PI / 2).toFloat()
                primary.volume = cos(angle)
                sec.volume = sin(angle)
                delay(STEP_MS)
                elapsed += STEP_MS
                // Bail cleanly if playback stopped/skip happened mid-fade — don't fight the user.
                if (!primary.isPlaying) break
            }

            // Primary is (or should be) silent now — safe to cut over onto the next item
            // inaudibly. Seeks to secondary's OWN current position, not 0 — secondary has been
            // genuinely playing this track for the whole fade window, so restarting primary from
            // the beginning here would audibly RESTART the song the instant control passes back
            // to it (the actual bug: "the crossfade transition finishes, then it restarts the
            // next song" — every previous version of this always seeked to position 0 no matter
            // what, throwing away however many seconds secondary had already played). Reading
            // secondary's position now, right before secondary gets torn down below, keeps the
            // handoff at the same timeline position on both sides — genuinely seamless, not just
            // volume-seamless. Skipped entirely if primary already auto-advanced onto this same
            // item on its own mid-fade (see primaryAutoAdvancedDuringFade's doc comment) — it's
            // already at its own correct, self-consistent position in that case, and forcing
            // another seek would only reintroduce a jump.
            primary.volume = 0f
            if (!primaryAutoAdvancedDuringFade) {
                primary.seekTo(nextIndex, sec.currentPosition)
            }
            primary.volume = 1f
            lastTransitionAtMs = System.currentTimeMillis()
        } catch (e: Exception) {
            Log.w(TAG, "Crossfade failed — falling back to a normal (non-crossfaded) transition.", e)
            primary.volume = 1f
        } finally {
            secondary?.let {
                runCatching { it.stop() }
                runCatching { it.release() }
            }
            secondary = null
        }
    }

    fun release() {
        pollJob?.cancel()
        crossfadeJob?.cancel()
        secondary?.let {
            runCatching { it.stop() }
            runCatching { it.release() }
        }
        secondary = null
    }
}
