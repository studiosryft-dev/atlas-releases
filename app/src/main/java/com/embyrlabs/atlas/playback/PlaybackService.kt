package com.embyrlabs.atlas.playback

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.embyrlabs.atlas.data.db.AtlasDatabase
import com.embyrlabs.atlas.data.settings.SettingsRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach

/**
 * The actual playback engine: a Media3 MediaSessionService hosting one ExoPlayer + one
 * MediaSession. This is what gives Atlas real lock-screen controls, screen-off playback, and
 * "keeps playing while you're in another app" — all handled by the Media3 framework once the
 * session exists, rather than anything custom here. Also owns the Equalizer's reactive
 * application (see EqualizerController) since it needs the same ExoPlayer instance.
 */
class PlaybackService : MediaSessionService() {

    private var mediaSession: MediaSession? = null
    private var equalizerController: EqualizerController? = null
    private var crossfadeController: CrossfadeController? = null
    private val serviceScope = CoroutineScope(Dispatchers.Default + Job())

    // Live-updated by a Flow collector below so the (non-suspend) broadcast receiver can check
    // it synchronously. Defaults matching SettingsRepository's own default (true) so there's no
    // brief "off" window before the first Flow emission lands.
    @Volatile private var bluetoothAutoPauseEnabled = true
    @Volatile private var autoplayEnabled = true
    private var noisyAudioReceiver: BroadcastReceiver? = null

    override fun onCreate() {
        super.onCreate()
        val player = ExoPlayer.Builder(this).build().apply {
            // Deliberately NOT using ExoPlayer's built-in setHandleAudioBecomingNoisy — that's
            // an unconditional, build-time-only setting, and this needs to be a runtime-
            // toggleable Settings switch (see the Bluetooth-disconnect registerReceiver below,
            // which is the actual mechanism now and respects bluetoothAutoPauseEnabled).
            addListener(object : Player.Listener {
                override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                    val trackId = mediaItem?.mediaId
                    val playlistId = mediaItem?.mediaMetadata?.extras?.getString(EXTRA_PLAYLIST_ID)
                    equalizerController?.currentContext?.value = trackId to playlistId

                    // Autoplay off = don't automatically continue into the next queued track;
                    // land on it paused instead of skipping it silently, so the user can still
                    // manually resume. Only intercepts a real auto-advance, never an explicit
                    // Next tap (MEDIA_ITEM_TRANSITION_REASON_SEEK).
                    if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO && !autoplayEnabled) {
                        mediaSession?.player?.pause()
                    }
                }

                // See EqualizerController.onAudioSessionChanged's doc comment — the session ID
                // at service startup is frequently a placeholder, not the one real audio ends
                // up playing through.
                override fun onAudioSessionIdChanged(audioSessionId: Int) {
                    equalizerController?.onAudioSessionChanged(audioSessionId)
                    VisualizerController.instance.onAudioSessionChanged(audioSessionId)
                }
            })
        }
        mediaSession = MediaSession.Builder(this, player).build()

        val settingsRepository = SettingsRepository(applicationContext)
        equalizerController = EqualizerController(
            player = player,
            settingsRepository = settingsRepository,
            database = AtlasDatabase.get(applicationContext),
            scope = serviceScope,
        ).also { it.start() }

        settingsRepository.bluetoothAutoPause
            .onEach { bluetoothAutoPauseEnabled = it }
            .launchIn(serviceScope)

        settingsRepository.autoplay
            .onEach { autoplayEnabled = it }
            .launchIn(serviceScope)

        crossfadeController = CrossfadeController(
            context = applicationContext,
            primary = player,
            settingsRepository = settingsRepository,
            scope = serviceScope,
        ).also { it.start() }

        // ACTION_AUDIO_BECOMING_NOISY is Android's own documented broadcast for exactly this:
        // fires whenever audio is about to switch to a "noisy" route (wired headphones
        // unplugged, OR — the case actually asked for — Bluetooth audio device disconnected).
        // One broadcast covers both scenarios; a Bluetooth-profile-specific API would need
        // extra runtime permissions on newer Android for less benefit.
        noisyAudioReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                if (intent?.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY && bluetoothAutoPauseEnabled) {
                    mediaSession?.player?.pause()
                }
            }
        }
        val filter = IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.registerReceiver(this, noisyAudioReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(noisyAudioReceiver, filter)
        }
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = mediaSession

    override fun onDestroy() {
        noisyAudioReceiver?.let { runCatching { unregisterReceiver(it) } }
        crossfadeController?.release()
        equalizerController?.release()
        VisualizerController.instance.stop()
        serviceScope.cancel()
        mediaSession?.run {
            player.release()
            release()
            mediaSession = null
        }
        super.onDestroy()
    }

    override fun onTaskRemoved(rootIntent: android.content.Intent?) {
        val player = mediaSession?.player
        if (player == null || !player.playWhenReady || player.mediaItemCount == 0
            || player.playbackState == Player.STATE_ENDED
        ) {
            stopSelf()
        }
        super.onTaskRemoved(rootIntent)
    }

    companion object {
        const val EXTRA_PLAYLIST_ID = "embyr.atlas.playlistId"
    }
}
