package com.embyrlabs.atlas.data.voiceisolation

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

private const val CHANNEL_ID = "atlas_voice_isolation"
private const val NOTIFICATION_ID = 1002

/**
 * Foreground service hosting a single Voice Isolation run — CPU-bound ONNX inference over a
 * full track can genuinely take minutes on a phone CPU, so like DownloadService this needs to
 * survive backgrounding rather than dying with the Activity. One job at a time: starting a new
 * one while another is running replaces it (mirrors how a user would expect "run this again"
 * to behave — there's no queue here, unlike downloads).
 */
class VoiceIsolationService : Service() {

    private val serviceScope = CoroutineScope(Dispatchers.Default + Job())
    private lateinit var engine: VoiceIsolationEngine

    override fun onCreate() {
        super.onCreate()
        engine = VoiceIsolationEngine(applicationContext)
        createNotificationChannelIfNeeded()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val trackId = intent?.getStringExtra(EXTRA_TRACK_ID)
        if (trackId == null) {
            stopSelf()
            return START_NOT_STICKY
        }
        val kinds = buildSet {
            if (intent.getBooleanExtra(EXTRA_VOCALS, false)) add(VoiceIsolationKind.VOCALS)
            if (intent.getBooleanExtra(EXTRA_INSTRUMENTAL, false)) add(VoiceIsolationKind.INSTRUMENTAL)
        }

        startForeground(NOTIFICATION_ID, buildNotification(0))
        VoiceIsolationController.jobState.value = VoiceIsolationJobState(trackId, 0, "RUNNING")

        serviceScope.launch {
            try {
                val results = engine.separate(trackId, kinds) { percent ->
                    VoiceIsolationController.jobState.value = VoiceIsolationJobState(trackId, percent, "RUNNING")
                    getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification(percent))
                }
                VoiceIsolationController.jobState.value =
                    VoiceIsolationJobState(trackId, 100, "DONE", resultTrackIds = results.map { it.id })
            } catch (e: Exception) {
                VoiceIsolationController.jobState.value =
                    VoiceIsolationJobState(trackId, 0, "FAILED", errorMessage = e.message ?: "Voice Isolation failed.")
            } finally {
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        serviceScope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannelIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, "Voice Isolation", NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun buildNotification(percent: Int): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Isolating voice")
            .setContentText("$percent%")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setProgress(100, percent, false)
            .setOngoing(true)
            .build()

    companion object {
        private const val EXTRA_TRACK_ID = "trackId"
        private const val EXTRA_VOCALS = "vocals"
        private const val EXTRA_INSTRUMENTAL = "instrumental"

        fun start(context: Context, trackId: String, vocals: Boolean, instrumental: Boolean) {
            val intent = Intent(context, VoiceIsolationService::class.java).apply {
                putExtra(EXTRA_TRACK_ID, trackId)
                putExtra(EXTRA_VOCALS, vocals)
                putExtra(EXTRA_INSTRUMENTAL, instrumental)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }
}
