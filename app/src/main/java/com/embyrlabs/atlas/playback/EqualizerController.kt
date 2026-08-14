package com.embyrlabs.atlas.playback

import android.media.audiofx.Equalizer
import android.util.Log
import androidx.media3.exoplayer.ExoPlayer
import com.embyrlabs.atlas.data.db.AtlasDatabase
import com.embyrlabs.atlas.data.db.EqualizerOwnerType
import com.embyrlabs.atlas.data.equalizer.buildBandLevelsMillibel
import com.embyrlabs.atlas.data.equalizer.customLevelsToPoints
import com.embyrlabs.atlas.data.equalizer.decodeCustomLevels
import com.embyrlabs.atlas.data.equalizer.presetById
import com.embyrlabs.atlas.data.settings.EqConfig
import com.embyrlabs.atlas.data.settings.SettingsRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach

private const val TAG = "EqualizerController"

/**
 * Owns the system `Equalizer` effect attached to the playback service's audio session, and
 * reactively keeps it in sync with whichever of (track override, playlist override, global
 * default, live in-editor preview) is currently the effective source — same precedence and
 * reasoning as documented on [EqualizerLiveOverride].
 *
 * Deliberately defensive: `Equalizer` construction/use is wrapped so a device that rejects the
 * effect (missing support, invalid session, etc.) degrades to "no EQ" rather than ever taking
 * playback down with it — the specific failure mode a prior project on this concept hit with a
 * custom AudioProcessor, which this whole system-effect approach exists to avoid in the first
 * place (see the Phase 4 plan notes).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class EqualizerController(
    private val player: ExoPlayer,
    private val settingsRepository: SettingsRepository,
    private val database: AtlasDatabase,
    private val scope: CoroutineScope,
) {
    private var equalizer: Equalizer? = null
    private var boundSessionId: Int = -1
    private var bandCenterFreqsHz: List<Int> = emptyList()
    private var bandLevelRange: IntRange = 0..0
    private var lastResolvedConfig: EqConfig? = null

    /** Updated by PlaybackService's Player.Listener on every media item transition. */
    val currentContext = MutableStateFlow<Pair<String?, String?>>(null to null) // (trackId, playlistId)

    fun start() {
        attachForSession(player.audioSessionId)

        val dao = database.equalizerDao()

        currentContext
            .flatMapLatest { (trackId, playlistId) ->
                val trackFlow = if (trackId != null) dao.observeOverride(trackId, EqualizerOwnerType.TRACK) else flowOf(null)
                val playlistFlow = if (playlistId != null) dao.observeOverride(playlistId, EqualizerOwnerType.PLAYLIST) else flowOf(null)

                combine(trackFlow, playlistFlow, settingsRepository.eqConfig, EqualizerLiveOverride.current) { track, playlist, global, live ->
                    resolveEffective(trackId, playlistId, track, playlist, global, live)
                }
            }
            .onEach { config -> lastResolvedConfig = config; applyToEqualizer(config) }
            .launchIn(scope)
    }

    /**
     * ExoPlayer's `audioSessionId` at [PlaybackService] startup (when [start] first runs) is
     * frequently 0/unset — no real audio track session exists yet since nothing has played.
     * Attaching a system `Equalizer` to that placeholder session is a real, documented cause of
     * it reporting zero bands or silently not affecting real playback once an actual session is
     * allocated later — some OEM audio stacks (Samsung's among them) bind effects strictly
     * per-session and don't migrate them. Call this whenever the real session ID changes (see
     * PlaybackService's `onAudioSessionIdChanged`) to rebuild the Equalizer against the session
     * that's actually carrying audio, and immediately re-apply whatever config was last
     * resolved so the rebuild doesn't audibly reset to flat until the next Flow emission.
     */
    fun onAudioSessionChanged(sessionId: Int) {
        if (sessionId == boundSessionId) return
        attachForSession(sessionId)
        lastResolvedConfig?.let { applyToEqualizer(it) }
    }

    private fun attachForSession(sessionId: Int) {
        try {
            equalizer?.release()
        } catch (e: Exception) {
            Log.w(TAG, "Error releasing previous Equalizer during session rebind.", e)
        }
        equalizer = null
        boundSessionId = sessionId

        try {
            val eq = Equalizer(0, sessionId)
            val range = eq.bandLevelRange
            bandLevelRange = range[0].toInt()..range[1].toInt()
            bandCenterFreqsHz = (0 until eq.numberOfBands).map { eq.getCenterFreq(it.toShort()) / 1000 }
            equalizer = eq
            Log.i(TAG, "Equalizer attached: session=$sessionId bands=${bandCenterFreqsHz.size} freqs=$bandCenterFreqsHz")
        } catch (e: Exception) {
            Log.w(TAG, "Equalizer unavailable for session=$sessionId — EQ will be a no-op until the session changes again.", e)
        }
    }

    private fun resolveEffective(
        trackId: String?,
        playlistId: String?,
        trackOverride: com.embyrlabs.atlas.data.db.EqualizerOverrideEntity?,
        playlistOverride: com.embyrlabs.atlas.data.db.EqualizerOverrideEntity?,
        global: EqConfig,
        live: EqualizerLiveOverride.LiveConfig?,
    ): EqConfig {
        if (trackOverride != null) {
            if (live != null && live.ownerId == trackId && live.ownerType == EqualizerOwnerType.TRACK) {
                return EqConfig(live.enabled, live.presetId, live.customLevelsJson)
            }
            return EqConfig(trackOverride.enabled, trackOverride.presetId, trackOverride.customLevelsJson)
        }
        if (playlistOverride != null) {
            if (live != null && live.ownerId == playlistId && live.ownerType == EqualizerOwnerType.PLAYLIST) {
                return EqConfig(live.enabled, live.presetId, live.customLevelsJson)
            }
            return EqConfig(playlistOverride.enabled, playlistOverride.presetId, playlistOverride.customLevelsJson)
        }
        if (live != null && live.ownerId == null && live.ownerType == null) {
            return EqConfig(live.enabled, live.presetId, live.customLevelsJson)
        }
        return global
    }

    private fun applyToEqualizer(config: EqConfig) {
        val eq = equalizer ?: return
        try {
            if (!config.enabled) {
                eq.enabled = false
                return
            }
            val points = if (config.presetId != null) {
                presetById(config.presetId).points
            } else {
                customLevelsToPoints(decodeCustomLevels(config.customLevelsJson ?: "[]"))
            }
            val levels = buildBandLevelsMillibel(points, bandCenterFreqsHz, bandLevelRange)
            eq.enabled = true
            levels.forEachIndexed { band, level -> eq.setBandLevel(band.toShort(), level) }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to apply EQ config — leaving playback audio untouched.", e)
        }
    }

    fun bandMetadata(): Pair<List<Int>, IntRange> = bandCenterFreqsHz to bandLevelRange

    fun release() {
        try {
            equalizer?.release()
        } catch (e: Exception) {
            Log.w(TAG, "Error releasing Equalizer", e)
        }
        equalizer = null
    }

}
