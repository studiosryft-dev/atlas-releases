package com.ryftlabs.atlas.bridge

import android.content.Context
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import com.ryftlabs.atlas.BuildConfig
import com.ryftlabs.atlas.data.db.AtlasDatabase
import com.ryftlabs.atlas.data.db.DownloadQueueItemEntity
import com.ryftlabs.atlas.data.db.DownloadStatus
import com.ryftlabs.atlas.data.db.EqualizerOverrideEntity
import com.ryftlabs.atlas.data.db.EqualizerOwnerType
import com.ryftlabs.atlas.data.db.NotificationEntity
import com.ryftlabs.atlas.data.db.PlaylistEntity
import com.ryftlabs.atlas.data.db.PlaylistTrackCrossRef
import com.ryftlabs.atlas.data.db.TrackEntity
import com.ryftlabs.atlas.data.download.DownloadEngine
import com.ryftlabs.atlas.data.download.DownloadQueueController
import com.ryftlabs.atlas.data.download.DownloadService
import com.ryftlabs.atlas.data.equalizer.CUSTOM_CURVE_FREQS_HZ
import com.ryftlabs.atlas.data.equalizer.EQ_PRESETS
import com.ryftlabs.atlas.data.equalizer.decodeCustomLevels
import com.ryftlabs.atlas.data.equalizer.encodeCustomLevels
import com.ryftlabs.atlas.data.equalizer.interpolateGainDb
import com.ryftlabs.atlas.data.equalizer.presetById
import com.ryftlabs.atlas.data.settings.SettingsRepository
import com.ryftlabs.atlas.data.settings.ThemeMode
import com.ryftlabs.atlas.data.voiceisolation.VoiceIsolationController
import com.ryftlabs.atlas.data.voiceisolation.VoiceIsolationEngine
import com.ryftlabs.atlas.data.voiceisolation.VoiceIsolationService
import com.ryftlabs.atlas.data.youtube.AudioQuality
import com.ryftlabs.atlas.data.youtube.YouTubeExtractorClient
import com.ryftlabs.atlas.playback.EqualizerLiveOverride
import com.ryftlabs.atlas.playback.PlaybackUiState
import com.ryftlabs.atlas.playback.PlayerController
import com.ryftlabs.atlas.playback.QueueManager
import com.ryftlabs.atlas.update.UpdateChecker
import com.ryftlabs.atlas.update.UpdateDownloader
import com.ryftlabs.atlas.update.UpdateInfo
import com.ryftlabs.atlas.update.UpdateInstaller
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

private const val TAG = "WebAppBridge"

/**
 * The entire native<->JS surface. One @JavascriptInterface entry point (`invoke`) dispatches
 * to every action by name rather than exposing dozens of separate methods, matching the
 * pattern the prior WebView build of this app used — one auditable dispatch point rather than
 * scattered @JavascriptInterface methods.
 *
 * Threading: `invoke` runs on a WebView-managed background thread. It launches into [scope]
 * (Dispatchers.Main), and every native call inside already hops to Dispatchers.IO itself where
 * needed (Room, network) — so this never blocks the main thread, but every call back into the
 * page (evaluateJavascript) happens on Main, which is required.
 *
 * Results resolve via `window.__atlasResolve(callId, jsonResultOrNull)` /
 * `window.__atlasReject(callId, message)` (see js/bridge.js for the Promise wrapper). Live data
 * (library/playlists/download queue/playback state) pushes via
 * `window.__atlasPush(event, json)` whenever the underlying Room Flow or player state changes,
 * rather than JS having to poll.
 */
class WebAppBridge(
    private val webView: WebView,
    private val context: Context,
    private val pickImage: ((String?) -> Unit) -> Unit,
    private val pasteFromClipboard: () -> String?,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    private val db = AtlasDatabase.get(context)
    private val trackDao = db.trackDao()
    private val playlistDao = db.playlistDao()
    private val downloadQueueDao = db.downloadQueueDao()
    private val equalizerDao = db.equalizerDao()
    private val notificationDao = db.notificationDao()
    private val settingsRepository = SettingsRepository(context)
    private val downloadEngine = DownloadEngine(context)

    private val playerController = PlayerController(context)
    val queueManager = QueueManager(playerController, scope, downloadEngine)
    private val voiceIsolationEngine = VoiceIsolationEngine(context)
    private val updateDownloader = UpdateDownloader(context)
    private var lastDownloadedUpdateApk: File? = null

    private var jsHandlesBack = false

    // Sleep timer lives here rather than in PlaybackService — it only ever needs to pause
    // playback through the same MediaController the rest of the bridge already uses, so a
    // second cross-process command channel into the service would be pure overhead.
    private var sleepTimerJob: kotlinx.coroutines.Job? = null
    private var sleepTimerEndsAtMs: Long? = null

    init {
        playerController.connect()

        trackDao.observeLibrary().onEach { push("library.changed", json.encodeToString(it)) }.launchIn(scope)
        trackDao.observeTrash().onEach { push("library.trash.changed", json.encodeToString(it)) }.launchIn(scope)
        playlistDao.observePlaylists().onEach { push("playlists.changed", json.encodeToString(it)) }.launchIn(scope)
        downloadQueueDao.observeQueue().onEach { push("downloadQueue.changed", json.encodeToString(it)) }.launchIn(scope)
        playerController.state.onEach { push("playback.state", encodePlaybackState(it)) }.launchIn(scope)
        queueManager.queueFlow.onEach { push("queue.changed", queueManager.encodeQueueState()) }.launchIn(scope)
        downloadQueueDao.observeQueue().onEach { handleDownloadQueueNotifications(it) }.launchIn(scope)
        notificationDao.observeAll().onEach { push("notifications.changed", json.encodeToString(it)) }.launchIn(scope)
        VoiceIsolationController.jobState.onEach { state ->
            if (state != null) push("voiceIsolation.progress", json.encodeToString(state))
            if (state?.status == "DONE") {
                insertNotification("info", "Voice Isolation complete", null)
            } else if (state?.status == "FAILED") {
                insertNotification("info", "Voice Isolation failed", state.errorMessage)
            }
        }.launchIn(scope)
    }

    // Tracks which download queue items we've already notified about, so a completion/failure
    // only ever produces one notification-center entry even though the item keeps emitting on
    // every subsequent, unrelated queue change (Flow re-emits the whole list on any row change).
    private val notifiedDownloadIds = mutableSetOf<String>()
    private var seededNotifiedIds = false

    private suspend fun handleDownloadQueueNotifications(items: List<DownloadQueueItemEntity>) {
        if (!seededNotifiedIds) {
            // Items already in a terminal state at first-subscribe (e.g. from before this
            // process started) shouldn't re-fire a notification just because notifiedDownloadIds
            // is empty on a fresh process — seed it once instead of announcing app-launch history.
            seededNotifiedIds = true
            items.filter { it.status == DownloadStatus.COMPLETED || it.status == DownloadStatus.FAILED }
                .forEach { notifiedDownloadIds += it.id }
            return
        }
        items.forEach { item ->
            if (item.id in notifiedDownloadIds) return@forEach
            when (item.status) {
                DownloadStatus.COMPLETED -> {
                    notifiedDownloadIds += item.id
                    insertNotification("download", "Download complete", item.resolvedTitle ?: item.youtubeUrl)
                }
                DownloadStatus.FAILED -> {
                    notifiedDownloadIds += item.id
                    insertNotification("info", "Download failed", item.resolvedTitle ?: item.errorMessage ?: item.youtubeUrl)
                }
                else -> Unit
            }
        }
    }

    /** Called once from MainActivity after StorageRevertCleanup finds and fixes anything left
     *  over from the brief period tracks/artwork were being written to public MediaStore
     *  storage — visible confirmation the cleanup ran, not silent. */
    suspend fun notifyStorageCleanup(movedCount: Int, removedDuplicates: Int) {
        val parts = mutableListOf<String>()
        if (movedCount > 0) parts += "$movedCount file${if (movedCount == 1) "" else "s"} moved back to private storage"
        if (removedDuplicates > 0) parts += "$removedDuplicates duplicate${if (removedDuplicates == 1) "" else "s"} removed"
        if (parts.isEmpty()) return
        insertNotification("info", "Library storage cleaned up", parts.joinToString(", ") + ".")
    }

    private suspend fun insertNotification(icon: String, title: String, body: String?) {
        val notification = NotificationEntity(icon = icon, title = title, body = body, createdAt = System.currentTimeMillis())
        notificationDao.insert(notification)
        push("notifications.new", json.encodeToString(notification))
    }

    @JavascriptInterface
    fun invoke(action: String, argsJson: String, callId: String) {
        scope.launch {
            try {
                val args = if (argsJson.isBlank()) JSONObject() else JSONObject(argsJson)
                val result = dispatch(action, args)
                resolve(callId, result)
            } catch (e: Exception) {
                Log.w(TAG, "action '$action' failed", e)
                reject(callId, e.message ?: "Something went wrong.")
            }
        }
    }

    private suspend fun dispatch(action: String, args: JSONObject): String? = when (action) {
        // ---------------- library ----------------
        "library.list" -> json.encodeToString(trackDao.observeLibrary().firstValue())
        "library.trashList" -> json.encodeToString(trackDao.observeTrash().firstValue())
        "library.search" -> json.encodeToString(trackDao.searchLibrary(args.getString("query")).firstValue())
        "library.rename" -> { trackDao.rename(args.getString("id"), args.getString("title"), args.getString("artist")); null }
        "library.toggleLiked" -> {
            val track = trackDao.findById(args.getString("id")) ?: throw Exception("Track not found.")
            trackDao.setLiked(track.id, !track.liked); null
        }
        "library.setArtwork" -> { setTrackArtworkFromContentUri(args.getString("id"), args.getString("contentUri")); null }
        "library.moveToTrash" -> { moveTrackToTrash(args.getString("id")); null }
        "library.restore" -> { restoreTrackFromTrash(args.getString("id")); null }
        "library.permanentlyDelete" -> {
            trackDao.findById(args.getString("id"))?.let { trackDao.delete(it) }; null
        }
        "library.recordPlay" -> { trackDao.recordPlay(args.getString("id"), System.currentTimeMillis()); null }
        "library.eraseAll" -> { eraseLibrary(args.optBoolean("moveToTrash", false)); null }
        "library.restoreAll" -> { restoreAllFromTrash(); null }
        "library.permanentlyDeleteAll" -> { trackDao.deleteAllTrashTracks(); null }

        // ---------------- playlists ----------------
        "playlists.list" -> json.encodeToString(playlistDao.observePlaylists().firstValue())
        "playlists.create" -> {
            val nextOrder = (playlistDao.maxSortOrder() ?: 0L) + 1
            val playlist = PlaylistEntity(
                name = args.getString("name"),
                artworkMode = args.optString("artworkMode", PlaylistEntity.DEFAULT_PRESET),
                createdAt = System.currentTimeMillis(),
                sortOrder = nextOrder,
            )
            playlistDao.insertPlaylist(playlist)
            json.encodeToString(playlist)
        }
        "playlists.rename" -> { playlistDao.rename(args.getString("id"), args.getString("name")); null }
        "playlists.delete" -> {
            playlistDao.getPlaylist(args.getString("id"))?.let { playlistDao.deletePlaylist(it) }; null
        }
        "playlists.setArtwork" -> {
            val id = args.getString("id")
            val playlist = playlistDao.getPlaylist(id) ?: throw Exception("Playlist not found.")
            val customUri = args.optString("contentUri", "")
            if (customUri.isNotBlank()) {
                val path = copyContentUriToArtwork(customUri, "playlist_$id")
                playlistDao.updatePlaylist(playlist.copy(artworkMode = "custom", customArtworkPath = path))
            } else {
                playlistDao.updatePlaylist(playlist.copy(artworkMode = args.getString("presetId"), customArtworkPath = null))
            }
            null
        }
        "playlists.setAnimated" -> {
            val playlist = playlistDao.getPlaylist(args.getString("id")) ?: throw Exception("Playlist not found.")
            playlistDao.updatePlaylist(playlist.copy(animated = args.getBoolean("animated")))
            null
        }
        "playlists.getTracks" -> json.encodeToString(playlistDao.observePlaylistTracks(args.getString("id")).firstValue())
        "playlists.addTrack" -> {
            val playlistId = args.getString("playlistId")
            val trackId = args.getString("trackId")
            val nextPosition = (playlistDao.maxTrackPosition(playlistId) ?: -1L) + 1
            playlistDao.addTrack(PlaylistTrackCrossRef(playlistId, trackId, nextPosition))
            null
        }
        "playlists.removeTrack" -> { playlistDao.removeTrack(args.getString("playlistId"), args.getString("trackId")); null }
        "playlists.reorder" -> {
            val playlistId = args.getString("playlistId")
            val orderedTrackIds = args.getJSONArray("trackIds").let { arr -> List(arr.length()) { arr.getString(it) } }
            orderedTrackIds.forEachIndexed { index, trackId -> playlistDao.setTrackPosition(playlistId, trackId, index.toLong()) }
            null
        }

        // ---------------- download queue ----------------
        "downloadQueue.list" -> json.encodeToString(downloadQueueDao.observeQueue().firstValue())
        "downloadQueue.enqueue" -> {
            downloadEngine.enqueue(args.getString("url"), args.optBoolean("asPlaylist", false))
            DownloadService.start(context); null
        }
        "downloadQueue.cancel" -> { downloadEngine.cancel(args.getString("id")); null }
        "downloadQueue.retry" -> {
            downloadQueueDao.findById(args.getString("id"))?.let {
                downloadQueueDao.update(it.copy(status = DownloadStatus.QUEUED, errorMessage = null, progressPercent = 0))
            }
            DownloadService.start(context); null
        }
        "downloadQueue.remove" -> { downloadQueueDao.findById(args.getString("id"))?.let { downloadQueueDao.delete(it) }; null }
        "downloadQueue.reorder" -> {
            val orderedIds = args.getJSONArray("ids").let { arr -> List(arr.length()) { arr.getString(it) } }
            orderedIds.forEachIndexed { index, id -> downloadQueueDao.reorder(id, index.toLong()) }
            null
        }
        "downloadQueue.start" -> { DownloadService.start(context); push("downloadQueue.runningState", "true"); null }
        "downloadQueue.stop" -> { DownloadService.stop(context); push("downloadQueue.runningState", "false"); null }
        "downloadQueue.getRunningState" -> (!DownloadQueueController.isPaused.value).toString()

        // ---------------- youtube ----------------
        "youtube.search" -> json.encodeToString(YouTubeExtractorClient.search(args.getString("query")))
        "youtube.getInfo" -> {
            val url = args.getString("url")
            if (looksLikePlaylistUrl(url)) {
                json.encodeToString(YouTubeExtractorClient.resolvePlaylist(url))
            } else {
                val quality = settingsRepository.currentAudioQuality()
                json.encodeToString(YouTubeExtractorClient.resolveVideo(url, quality))
            }
        }

        // ---------------- playback ----------------
        "playback.playQueue" -> {
            val ids = args.getJSONArray("trackIds").let { arr -> List(arr.length()) { arr.getString(it) } }
            val startIndex = args.optInt("startIndex", 0)
            val playlistContextId = args.optString("playlistContextId", "").ifBlank { null }
            val tracks = ids.mapNotNull { trackDao.findById(it) }
            queueManager.playQueue(tracks, startIndex, playlistContextId)
            playlistContextId?.let { playlistDao.incrementPlayCount(it) }
            null
        }
        "playback.playShuffled" -> {
            val ids = args.getJSONArray("trackIds").let { arr -> List(arr.length()) { arr.getString(it) } }
            val playlistContextId = args.optString("playlistContextId", "").ifBlank { null }
            val tracks = ids.mapNotNull { trackDao.findById(it) }
            queueManager.playShuffled(tracks, playlistContextId)
            playlistContextId?.let { playlistDao.incrementPlayCount(it) }
            null
        }
        "playback.togglePlayPause" -> { playerController.togglePlayPause(); null }
        "playback.setRepeatMode" -> { playerController.setRepeatMode(args.getInt("mode")); null }
        "visualizer.start" -> {
            val reduced = args.optBoolean("reduced", false)
            com.ryftlabs.atlas.playback.VisualizerController.instance.start(if (reduced) 140L else 66L) { bars ->
                push("playback.visualizerData", JSONArray(bars.map { it.toDouble() }).toString())
            }
            null
        }
        "visualizer.stop" -> { com.ryftlabs.atlas.playback.VisualizerController.instance.stop(); null }
        "playback.next" -> { queueManager.playNext(); null }
        "playback.previous" -> { playerController.skipPrevious(); null }
        "playback.seek" -> { playerController.seekTo(args.getLong("positionMs")); null }
        "playback.getState" -> encodePlaybackState(playerController.state.value)
        "queue.get" -> queueManager.encodeQueueState()
        "queue.reorder" -> { queueManager.reorder(args.getInt("fromIndex"), args.getInt("toIndex")); null }
        "queue.remove" -> { queueManager.removeAt(args.getInt("index")); null }
        "queue.clear" -> { queueManager.clear(); null }
        "queue.reAddFromHistory" -> { queueManager.reAddFromHistory(args.getInt("historyIndex")); null }
        "queue.playIndex" -> { queueManager.playIndex(args.getInt("index")); null }
        "playback.setSleepTimer" -> { setSleepTimer(args.getInt("minutes")); null }
        "playback.getSleepTimer" -> encodeSleepTimer()
        "settings.setAutoplay" -> { settingsRepository.setAutoplay(args.getBoolean("enabled")); null }
        "settings.setBackgroundAnimationEnabled" -> { settingsRepository.setBackgroundAnimationEnabled(args.getBoolean("enabled")); null }
        "settings.setBackgroundAnimationSpeed" -> { settingsRepository.setBackgroundAnimationSpeed(args.getDouble("speed").toFloat()); null }
        "settings.setPhoneHeatOptimization" -> { settingsRepository.setPhoneHeatOptimization(args.getBoolean("enabled")); null }

        // ---------------- settings ----------------
        "settings.get" -> encodeSettings()
        "settings.setWifiOnly" -> { settingsRepository.setWifiOnly(args.getBoolean("enabled")); null }
        "settings.setAudioQuality" -> { settingsRepository.setAudioQuality(AudioQuality.valueOf(args.getString("quality"))); null }
        "settings.setThemeMode" -> { settingsRepository.setThemeMode(ThemeMode.valueOf(args.getString("mode"))); null }
        "settings.setColorway" -> { settingsRepository.setColorway(args.getString("colorway")); null }
        "settings.setIdleCompression" -> { settingsRepository.setIdleCompression(args.getBoolean("enabled")); null }
        "settings.setIdleCompressionDays" -> { settingsRepository.setIdleCompressionDays(args.getInt("days")); null }
        "settings.setBluetoothAutoPause" -> { settingsRepository.setBluetoothAutoPause(args.getBoolean("enabled")); null }
        "settings.setCrossfadeSeconds" -> { settingsRepository.setCrossfadeSeconds(args.getDouble("seconds").toFloat()); null }
        "settings.storageStats" -> encodeStorageStats()
        "settings.wipeLocalData" -> { wipeLocalData(); null }

        // ---------------- equalizer ----------------
        "equalizer.presets" -> json.encodeToString(EQ_PRESETS.map { it.id to it.label })
        "equalizer.getConfig" -> encodeEqualizerConfig(
            args.optString("ownerId", "").ifBlank { null },
            args.optString("ownerType", "").ifBlank { null },
            args.optString("previewPresetId", "").ifBlank { null },
        )
        "equalizer.setLive" -> {
            val presetId = args.optString("presetId", "").ifBlank { null }
            // JS sends the raw 5-point gainsDb array while dragging rather than a pre-encoded
            // customLevelsJson string (it doesn't know EqualizerPresets.kt's encoding scheme) —
            // encode it here, same convention encodeCustomLevels/decodeCustomLevels use elsewhere.
            val gainsDb = args.optJSONArray("gainsDb")?.let { arr -> List(arr.length()) { arr.getDouble(it).toFloat() } }
            val customJson = if (presetId == null && gainsDb != null) encodeCustomLevels(gainsDb) else null

            EqualizerLiveOverride.push(
                EqualizerLiveOverride.LiveConfig(
                    ownerId = args.optString("ownerId", "").ifBlank { null },
                    ownerType = args.optString("ownerType", "").ifBlank { null }?.let { EqualizerOwnerType.valueOf(it) },
                    enabled = args.getBoolean("enabled"),
                    presetId = presetId,
                    customLevelsJson = customJson,
                )
            )
            null
        }
        "equalizer.clearLive" -> { EqualizerLiveOverride.clear(); null }
        "equalizer.saveAndApply" -> { saveEqualizerConfig(args); null }
        "equalizer.reset" -> {
            // "Reset" = back to flat, enabled — same defaults SettingsRepository falls back to
            // on a fresh install, applied explicitly rather than just clearing keys (clearing
            // would fall back to "flat" too today, but being explicit here doesn't silently
            // change behavior if that default ever changes for other reasons).
            settingsRepository.setEqEnabled(true)
            settingsRepository.setEqPreset("flat")
            EqualizerLiveOverride.clear()
            null
        }
        "equalizer.useGlobalDefault" -> {
            val ownerId = args.getString("ownerId")
            val ownerType = EqualizerOwnerType.valueOf(args.getString("ownerType"))
            equalizerDao.clear(ownerId, ownerType)
            EqualizerLiveOverride.clear()
            null
        }

        // ---------------- voice isolation ----------------
        "voiceIsolation.status" -> JSONObject().put("modelReady", voiceIsolationEngine.isModelReady()).toString()
        "voiceIsolation.downloadModel" -> {
            // Not foreground-service-backed (unlike track downloads/isolation itself) — a
            // single network fetch is much less likely to get killed mid-flight than minutes of
            // CPU inference, and keeping this scoped to the bridge avoids a third service for a
            // one-shot action. Worth revisiting if backgrounding during this turns out common.
            scope.launch {
                try {
                    voiceIsolationEngine.downloadModel { percent -> push("voiceIsolation.modelDownloadProgress", percent.toString()) }
                    push("voiceIsolation.modelDownloadProgress", "100")
                } catch (e: Exception) {
                    push("voiceIsolation.modelDownloadFailed", JSONObject().put("error", e.message ?: "Download failed.").toString())
                }
            }
            null
        }
        "voiceIsolation.process" -> {
            val trackId = args.getString("trackId")
            val vocals = args.optBoolean("vocals", false)
            val instrumental = args.optBoolean("instrumental", false)
            VoiceIsolationService.start(context, trackId, vocals, instrumental)
            null
        }
        "voiceIsolation.getJobState" -> VoiceIsolationController.jobState.value?.let { json.encodeToString(it) }

        // ---------------- updates ----------------
        "updates.check" -> {
            val result = runCatching { UpdateChecker.checkForUpdate(BuildConfig.VERSION_CODE) }
            result.fold(
                onSuccess = { info ->
                    if (info == null) {
                        // "Up to date" per the spec is Notification-Center-only, no toast — see
                        // notifications.create just above for why a plain notificationDao.insert
                        // (skipping insertNotification's push("notifications.new")) is silent.
                        notificationDao.insert(
                            NotificationEntity(
                                icon = "info",
                                title = "Atlas is up to date",
                                body = "You're running the latest version of Atlas.",
                                createdAt = System.currentTimeMillis(),
                            )
                        )
                    } else {
                        notificationDao.insert(
                            NotificationEntity(
                                icon = "update",
                                title = "Update available — v${info.version}",
                                body = info.releaseNotes,
                                createdAt = System.currentTimeMillis(),
                                dataJson = json.encodeToString(info),
                            )
                        )
                    }
                    JSONObject().put("available", info != null).toString()
                },
                onFailure = { e ->
                    notificationDao.insert(
                        NotificationEntity(
                            icon = "info",
                            title = "Couldn't check for updates",
                            body = e.message ?: "Check your connection and try again.",
                            createdAt = System.currentTimeMillis(),
                        )
                    )
                    JSONObject().put("available", false).put("error", e.message ?: "Update check failed.").toString()
                },
            )
        }
        "updates.download" -> {
            val info = UpdateInfo(
                version = args.getString("version"),
                versionCode = args.getInt("versionCode"),
                apkUrl = args.getString("apkUrl"),
                sizeBytes = args.optLong("sizeBytes", 0L),
                releaseNotes = args.optString("releaseNotes", "").ifBlank { null },
                mandatory = args.optBoolean("mandatory", false),
            )
            try {
                val file = updateDownloader.download(info) { percent ->
                    push("updates.downloadProgress", JSONObject().put("percent", percent).toString())
                }
                lastDownloadedUpdateApk = file
                JSONObject().put("success", true).toString()
            } catch (e: Exception) {
                JSONObject().put("success", false).put("error", e.message ?: "Download failed.").toString()
            }
        }
        "updates.install" -> {
            val apk = lastDownloadedUpdateApk
            when {
                apk == null || !apk.exists() -> JSONObject().put("error", "No downloaded update found — try downloading it again.").toString()
                !UpdateInstaller.canRequestInstall(context) -> {
                    UpdateInstaller.openInstallPermissionSettings(context)
                    JSONObject().put("needsPermission", true).toString()
                }
                else -> {
                    UpdateInstaller.install(context, apk)
                    JSONObject().put("started", true).toString()
                }
            }
        }

        // ---------------- notifications ----------------
        "notifications.list" -> json.encodeToString(notificationDao.observeAll().firstValue())
        "notifications.create" -> {
            // JS-triggered toasts (e.g. "Added to Download Queue", "Reset email sent") call this
            // so they land in the persisted history too — JS already renders its own toast
            // immediately, so this doesn't re-push "notifications.new" to avoid a duplicate popup.
            notificationDao.insert(
                NotificationEntity(
                    icon = args.optString("icon", "info"),
                    title = args.getString("title"),
                    body = args.optString("body", "").ifBlank { null },
                    createdAt = System.currentTimeMillis(),
                )
            )
            null
        }
        "notifications.markRead" -> { notificationDao.markRead(args.getString("id")); null }
        "notifications.markAllRead" -> { notificationDao.markAllRead(); null }
        "notifications.delete" -> { notificationDao.delete(args.getString("id")); null }
        "notifications.clear" -> { notificationDao.clear(); null }

        // ---------------- misc ----------------
        "clipboard.paste" -> JSONObject().put("text", pasteFromClipboard() ?: "").toString()
        "device.pickImage" -> pickImageSuspending()
        "device.setJsHandlesBack" -> { jsHandlesBack = args.getBoolean("value"); null }

        else -> throw Exception("Unknown bridge action: $action")
    }

    // ---------------- helpers ----------------

    private suspend fun <T> Flow<T>.firstValue(): T =
        this.first()

    private fun looksLikePlaylistUrl(url: String) = url.contains("list=")

    private fun encodePlaybackState(state: PlaybackUiState): String = JSONObject().apply {
        put("currentTrackId", state.currentTrackId)
        put("title", state.title)
        put("artist", state.artist)
        put("artworkPath", state.artworkPath)
        put("qualityLabel", state.qualityLabel)
        put("isPlaying", state.isPlaying)
        put("positionMs", state.positionMs)
        put("durationMs", state.durationMs)
        put("repeatMode", state.repeatMode)
    }.toString()

    private suspend fun encodeSettings(): String {
        val wifiOnly = settingsRepository.currentWifiOnly()
        val quality = settingsRepository.currentAudioQuality()
        val theme = settingsRepository.themeMode.firstValue()
        val colorway = settingsRepository.colorway.firstValue()
        val idleCompression = settingsRepository.idleCompression.firstValue()
        val idleCompressionDays = settingsRepository.idleCompressionDays.firstValue()
        val bluetoothAutoPause = settingsRepository.bluetoothAutoPause.firstValue()
        val crossfadeSeconds = settingsRepository.crossfadeSeconds.firstValue()
        val autoplay = settingsRepository.autoplay.firstValue()
        val backgroundAnimationEnabled = settingsRepository.backgroundAnimationEnabled.firstValue()
        val backgroundAnimationSpeed = settingsRepository.backgroundAnimationSpeed.firstValue()
        val phoneHeatOptimization = settingsRepository.phoneHeatOptimization.firstValue()
        return JSONObject()
            .put("wifiOnly", wifiOnly)
            .put("audioQuality", quality.name)
            .put("themeMode", theme.name)
            .put("colorway", colorway)
            .put("idleCompression", idleCompression)
            .put("idleCompressionDays", idleCompressionDays)
            .put("bluetoothAutoPause", bluetoothAutoPause)
            .put("crossfadeSeconds", crossfadeSeconds)
            .put("autoplay", autoplay)
            .put("backgroundAnimationEnabled", backgroundAnimationEnabled)
            .put("backgroundAnimationSpeed", backgroundAnimationSpeed)
            .put("phoneHeatOptimization", phoneHeatOptimization)
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("appVersionCode", BuildConfig.VERSION_CODE)
            .toString()
    }

    /** minutes <= 0 cancels any running timer. Re-arming (calling this again while one is
     *  already running) replaces it outright rather than stacking. */
    private fun setSleepTimer(minutes: Int) {
        sleepTimerJob?.cancel()
        sleepTimerJob = null
        sleepTimerEndsAtMs = null
        if (minutes <= 0) {
            push("playback.sleepTimer", encodeSleepTimer())
            return
        }
        val endsAt = System.currentTimeMillis() + minutes * 60_000L
        sleepTimerEndsAtMs = endsAt
        sleepTimerJob = scope.launch {
            kotlinx.coroutines.delay(minutes * 60_000L)
            playerController.pause()
            sleepTimerEndsAtMs = null
            push("playback.sleepTimer", encodeSleepTimer())
        }
        push("playback.sleepTimer", encodeSleepTimer())
    }

    private fun encodeSleepTimer(): String =
        JSONObject().apply { put("endsAtMs", sleepTimerEndsAtMs ?: JSONObject.NULL) }.toString()

    private suspend fun encodeStorageStats(): String = kotlinx.coroutines.withContext(Dispatchers.IO) {
        val tracksDir = File(context.filesDir, "tracks")
        val artworkDir = File(context.filesDir, "artwork")
        val trackFiles = tracksDir.listFiles().orEmpty()
        val artworkFiles = artworkDir.listFiles().orEmpty()
        val totalBytes = (trackFiles.toList() + artworkFiles.toList()).sumOf { it.length() }
        JSONObject().put("trackCount", trackFiles.size).put("totalBytes", totalBytes).toString()
    }

    private suspend fun wipeLocalData() = kotlinx.coroutines.withContext(Dispatchers.IO) {
        db.clearAllTables()
        settingsRepository.clearAll()
        File(context.filesDir, "tracks").deleteRecursively()
        File(context.filesDir, "artwork").deleteRecursively()
    }

    /**
     * The UI always shows the same fixed 5 reference points (see CUSTOM_CURVE_FREQS_HZ)
     * regardless of what the connected device's real Equalizer reports — deliberately decoupled
     * from live device band metadata, which used to make the entire EQ screen unusable ("this
     * device doesn't expose an equalizer") whenever a device transiently failed to construct
     * the effect. The UI/settings are now always available and always save correctly; whether
     * they audibly apply depends on the device's Equalizer support, which EqualizerController's
     * session-rebind logic makes more robust but can't guarantee on every device. Gain range is
     * a fixed +-15dB UI range, not the device's own reported range — buildBandLevelsMillibel
     * clamps to whatever the real device range is at apply time regardless.
     */
    private suspend fun encodeEqualizerConfig(ownerId: String?, ownerType: String?, previewPresetId: String? = null): String {
        val override = if (ownerId != null && ownerType != null) {
            equalizerDao.getOverride(ownerId, EqualizerOwnerType.valueOf(ownerType))
        } else null

        val (enabled, presetId, customJson) = if (override != null) {
            Triple(override.enabled, override.presetId, override.customLevelsJson)
        } else {
            val global = settingsRepository.eqConfig.firstValue()
            Triple(global.enabled, global.presetId, global.customLevelsJson)
        }

        // previewPresetId lets the UI ask "what would this preset's curve look like" (for the
        // graph, while the user is browsing presets) without actually saving anything.
        val effectivePresetId = previewPresetId ?: presetId
        val gainsDb = if (effectivePresetId != null) {
            CUSTOM_CURVE_FREQS_HZ.map { freq -> interpolateGainDb(presetById(effectivePresetId).points, freq) }
        } else {
            decodeCustomLevels(customJson ?: "[]")
        }

        return JSONObject()
            .put("enabled", enabled)
            .put("presetId", presetId)
            .put("hasOwnOverride", override != null)
            .put("freqsHz", JSONArray(CUSTOM_CURVE_FREQS_HZ))
            .put("rangeMinDb", -15)
            .put("rangeMaxDb", 15)
            .put("gainsDb", JSONArray(gainsDb))
            .toString()
    }

    private suspend fun saveEqualizerConfig(args: JSONObject) {
        val ownerId = args.optString("ownerId", "").ifBlank { null }
        val ownerType = args.optString("ownerType", "").ifBlank { null }
        val enabled = args.getBoolean("enabled")
        val presetId = args.optString("presetId", "").ifBlank { null }
        val gainsDb = args.optJSONArray("gainsDb")?.let { arr -> List(arr.length()) { arr.getDouble(it).toFloat() } }
        val customJson = if (presetId == null && gainsDb != null) encodeCustomLevels(gainsDb) else null

        if (ownerId != null && ownerType != null) {
            equalizerDao.upsert(
                EqualizerOverrideEntity(
                    ownerId = ownerId,
                    ownerType = EqualizerOwnerType.valueOf(ownerType),
                    presetId = presetId,
                    customLevelsJson = customJson,
                    enabled = enabled,
                )
            )
        } else {
            settingsRepository.setEqEnabled(enabled)
            if (presetId != null) settingsRepository.setEqPreset(presetId) else settingsRepository.setEqCustomLevels(customJson ?: "{}")
        }
        EqualizerLiveOverride.clear()
    }

    private suspend fun setTrackArtworkFromContentUri(trackId: String, contentUri: String) {
        val path = copyContentUriToArtwork(contentUri, "track_$trackId")
        trackDao.updateArtwork(trackId, path)
    }

    private suspend fun copyContentUriToArtwork(contentUriString: String, filenamePrefix: String): String =
        kotlinx.coroutines.withContext(Dispatchers.IO) {
            val artDir = File(context.filesDir, "artwork").apply { mkdirs() }
            val destFile = File(artDir, "custom_${filenamePrefix}_${UUID.randomUUID()}.jpg")
            val uri = android.net.Uri.parse(contentUriString)
            context.contentResolver.openInputStream(uri)?.use { input ->
                destFile.outputStream().use { output -> input.copyTo(output) }
            }
            destFile.absolutePath
        }

    private suspend fun moveTrackToTrash(trackId: String) {
        val track = trackDao.findById(trackId) ?: return
        kotlinx.coroutines.withContext(Dispatchers.IO) { runCatching { File(track.localFilePath).delete() } }
        trackDao.moveToTrash(track.id, System.currentTimeMillis())
    }

    /**
     * Settings > Downloads > Erase Library. Playlists always delete outright — there's no
     * playlist-trash concept in this app, only track-trash — so [moveToTrash] only changes
     * what happens to the tracks themselves. Either way every track's audio file is deleted
     * immediately (same as a single moveToTrash), the difference is whether the Room rows
     * survive as 30-day-retained trash metadata or are dropped in the same pass.
     */
    private suspend fun eraseLibrary(moveToTrash: Boolean) = kotlinx.coroutines.withContext(Dispatchers.IO) {
        val tracks = trackDao.allLibraryTracks()
        tracks.forEach { runCatching { File(it.localFilePath).delete() } }

        if (moveToTrash) {
            val now = System.currentTimeMillis()
            tracks.forEach { trackDao.moveToTrash(it.id, now) }
        } else {
            trackDao.deleteAllLibraryTracks()
        }

        playlistDao.deleteAllCrossRefs()
        playlistDao.deleteAllPlaylists()
    }

    private suspend fun restoreTrackFromTrash(trackId: String) {
        val track = trackDao.findById(trackId) ?: return
        if (track.derivedKind != null) {
            // A Voice Isolation result — moveTrackToTrash deletes the audio file like any other
            // trashed track, but there's no sourceUrl to re-download a derived track from (it
            // only ever existed as separation output). Trashing one is effectively permanent;
            // re-running Voice Isolation on the original track produces a fresh copy instead.
            throw Exception("This was a Voice Isolation result — re-run Voice Isolation on the original track to get it back.")
        }
        trackDao.delete(track)
        downloadEngine.enqueue(track.sourceUrl)
        DownloadService.start(context)
    }

    /** Library > Trash > "Recover All" — restores every non-derived trashed track (Voice
     *  Isolation results still can't be restored, same reasoning as the single-track case in
     *  [restoreTrackFromTrash]), enqueuing all the re-downloads before starting the download
     *  service once rather than once per track. */
    private suspend fun restoreAllFromTrash() {
        val tracks = trackDao.allTrashTracks().filter { it.derivedKind == null }
        tracks.forEach { track ->
            trackDao.delete(track)
            downloadEngine.enqueue(track.sourceUrl)
        }
        if (tracks.isNotEmpty()) DownloadService.start(context)
    }

    private suspend fun pickImageSuspending(): String = kotlinx.coroutines.suspendCancellableCoroutine { cont ->
        pickImage { uri -> cont.resumeWith(Result.success(JSONObject().put("contentUri", uri).toString())) }
    }

    // ---------------- JS call resolution ----------------

    private fun resolve(callId: String, resultJson: String?) {
        webView.post {
            val js = if (resultJson != null) {
                "window.__atlasResolve(\"$callId\", ${JSONObject.quote(resultJson)})"
            } else {
                "window.__atlasResolve(\"$callId\", null)"
            }
            webView.evaluateJavascript(js, null)
        }
    }

    private fun reject(callId: String, message: String) {
        webView.post {
            webView.evaluateJavascript("window.__atlasReject(\"$callId\", ${JSONObject.quote(message)})", null)
        }
    }

    private fun push(event: String, dataJson: String) {
        webView.post {
            webView.evaluateJavascript("window.__atlasPush && window.__atlasPush(\"$event\", ${JSONObject.quote(dataJson)})", null)
        }
    }

    fun notifyBackPressed() {
        webView.post { webView.evaluateJavascript("window.__atlasBackPressed && window.__atlasBackPressed()", null) }
    }

    fun destroy() {
        playerController.release()
        scope.cancel()
    }
}
