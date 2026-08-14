package com.embyrlabs.atlas.data.download

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.embyrlabs.atlas.data.settings.SettingsRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch

private const val CHANNEL_ID = "atlas_downloads"
private const val NOTIFICATION_ID = 1001
private const val WIFI_WAIT_RETRY_MS = 15_000L
private const val PAUSE_RECHECK_MS = 800L

// How many tracks download at once. 3 keeps real headroom under OkHttp's default
// max-requests-per-host limit (5) while still giving a big real-world speedup on
// multi-track/playlist imports over the old one-at-a-time queue.
private const val CONCURRENT_WORKERS = 3

/**
 * Foreground service so the download queue keeps processing when the app is backgrounded or
 * the screen is off — a bare ViewModel-scoped coroutine would get killed with the Activity.
 * Started (not bound) — LibraryScreen/DownloadQueueScreen enqueue work directly into Room via
 * DownloadEngine.enqueue and then ping this service to make sure the processing loop is
 * running; the service stops itself once the queue drains.
 */
class DownloadService : Service() {

    private val serviceScope = CoroutineScope(Dispatchers.IO + Job())
    private lateinit var engine: DownloadEngine
    private lateinit var settings: SettingsRepository
    private var processingJob: Job? = null

    override fun onCreate() {
        super.onCreate()
        engine = DownloadEngine(applicationContext)
        settings = SettingsRepository(applicationContext)
        createNotificationChannelIfNeeded()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification("Processing downloads..."))
        startProcessingLoopIfNeeded()
        return START_STICKY
    }

    private fun startProcessingLoopIfNeeded() {
        if (processingJob?.isActive == true) return
        processingJob = serviceScope.launch {
            val workers = List(CONCURRENT_WORKERS) {
                launch {
                    engine.runWorkerLoop(
                        getQuality = { settings.currentAudioQuality() },
                        shouldWait = ::waitIfPausedOrWifiOnlyAndOffline,
                    )
                }
            }
            workers.joinAll()
            stopSelf()
        }
    }

    /** Returns true (and delays first) if the queue is user-paused, or Wi-Fi-only is on but
     *  we're not on Wi-Fi right now — the caller should skip this iteration rather than claim a
     *  queue item. Re-checked periodically so downloads resume automatically once unpaused or
     *  Wi-Fi is back, no user action needed beyond flipping the toggle. */
    private suspend fun waitIfPausedOrWifiOnlyAndOffline(): Boolean {
        if (DownloadQueueController.isPaused.value) {
            delay(PAUSE_RECHECK_MS)
            return true
        }
        if (settings.currentWifiOnly() && !isOnWifi()) {
            delay(WIFI_WAIT_RETRY_MS)
            return true
        }
        return false
    }

    private fun isOnWifi(): Boolean {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return true
        val network = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(network) ?: return false
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
    }

    override fun onDestroy() {
        processingJob?.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannelIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, "Downloads", NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun buildNotification(text: String): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Atlas")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setOngoing(true)
            .build()

    companion object {
        fun start(context: Context) {
            DownloadQueueController.resume()
            val intent = Intent(context, DownloadService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        /** Pauses claiming (in-flight chunk transfers finish naturally, nothing is corrupted)
         *  and stops the foreground service — resumed later via [start]. */
        fun stop(context: Context) {
            DownloadQueueController.pause()
            context.stopService(Intent(context, DownloadService::class.java))
        }
    }
}
