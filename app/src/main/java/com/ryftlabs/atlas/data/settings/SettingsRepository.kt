package com.ryftlabs.atlas.data.settings

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.ryftlabs.atlas.data.youtube.AudioQuality
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

enum class ThemeMode { LIGHT, DARK, DEFAULT }

/** presetId null means "use customLevelsJson" — same convention as EqualizerOverrideEntity. */
data class EqConfig(val enabled: Boolean, val presetId: String?, val customLevelsJson: String?)

private val Context.dataStore by preferencesDataStore(name = "atlas_settings")

/** DataStore-backed app settings — download behavior, appearance, and the global equalizer
 *  default (per-track/per-playlist overrides live in Room instead, see EqualizerDao). */
class SettingsRepository(private val context: Context) {

    private object Keys {
        val WIFI_ONLY = booleanPreferencesKey("download_wifi_only")
        val AUDIO_QUALITY = stringPreferencesKey("download_audio_quality")
        val THEME_MODE = stringPreferencesKey("theme_mode")
        val EQ_ENABLED = booleanPreferencesKey("eq_enabled")
        val EQ_PRESET_ID = stringPreferencesKey("eq_preset_id")
        val EQ_CUSTOM_LEVELS = stringPreferencesKey("eq_custom_levels_json")
        val COLORWAY = stringPreferencesKey("colorway")
        val IDLE_COMPRESSION = booleanPreferencesKey("idle_compression")
        val IDLE_COMPRESSION_DAYS = androidx.datastore.preferences.core.intPreferencesKey("idle_compression_days")
        val STORAGE_REVERT_CLEANUP_DONE = booleanPreferencesKey("storage_revert_cleanup_done_v1")
        val BLUETOOTH_AUTO_PAUSE = booleanPreferencesKey("bluetooth_auto_pause")
        val CROSSFADE_SECONDS = floatPreferencesKey("crossfade_seconds")
        val AUTOPLAY = booleanPreferencesKey("autoplay")
        val BACKGROUND_ANIMATION_ENABLED = booleanPreferencesKey("background_animation_enabled")
        val BACKGROUND_ANIMATION_SPEED = floatPreferencesKey("background_animation_speed")
        val PHONE_HEAT_OPTIMIZATION = booleanPreferencesKey("phone_heat_optimization")
    }

    /** When on, IdleCompressionSweeper (run once per app launch) removes the local audio file
     *  for any downloaded Library track that hasn't been played (or added) in
     *  [idleCompressionDays] days — the track stays fully visible in Library/playlists, just
     *  isn't playable offline until QueueManager auto-re-downloads it on next play/queue. */
    val idleCompression: Flow<Boolean> = context.dataStore.data.map { it[Keys.IDLE_COMPRESSION] ?: false }

    suspend fun setIdleCompression(enabled: Boolean) {
        context.dataStore.edit { it[Keys.IDLE_COMPRESSION] = enabled }
    }

    val idleCompressionDays: Flow<Int> = context.dataStore.data.map { it[Keys.IDLE_COMPRESSION_DAYS] ?: 14 }

    suspend fun setIdleCompressionDays(days: Int) {
        context.dataStore.edit { it[Keys.IDLE_COMPRESSION_DAYS] = days }
    }

    /** One-time flag — see StorageRevertCleanup. A prior version of the app briefly wrote
     *  downloaded audio/artwork to public MediaStore storage (survive-uninstall experiment,
     *  reverted); this gates the one-time pass that pulls anything already written there back
     *  into private storage and merges any duplicate library rows that experiment caused. */
    val storageRevertCleanupDone: Flow<Boolean> = context.dataStore.data.map { it[Keys.STORAGE_REVERT_CLEANUP_DONE] ?: false }

    suspend fun setStorageRevertCleanupDone(done: Boolean) {
        context.dataStore.edit { it[Keys.STORAGE_REVERT_CLEANUP_DONE] = done }
    }

    // Default true — "so your music doesn't continue blasting after you take your airpods
    // out," per the product decision this shipped from; opt-out, not opt-in.
    val bluetoothAutoPause: Flow<Boolean> = context.dataStore.data.map { it[Keys.BLUETOOTH_AUTO_PAUSE] ?: true }
    suspend fun currentBluetoothAutoPause(): Boolean = bluetoothAutoPause.first()
    suspend fun setBluetoothAutoPause(enabled: Boolean) {
        context.dataStore.edit { it[Keys.BLUETOOTH_AUTO_PAUSE] = enabled }
    }

    // 0 = off. Apple Music's own crossfade UI tops out around 12s; matching that ceiling.
    val crossfadeSeconds: Flow<Float> = context.dataStore.data.map { it[Keys.CROSSFADE_SECONDS] ?: 0f }
    suspend fun currentCrossfadeSeconds(): Float = crossfadeSeconds.first()
    suspend fun setCrossfadeSeconds(seconds: Float) {
        context.dataStore.edit { it[Keys.CROSSFADE_SECONDS] = seconds.coerceIn(0f, 12f) }
    }

    // Default true — matches QueueManager's own existing playlist/library-continuation behavior;
    // this setting just makes it visible/toggleable from the Now Playing queue panel.
    val autoplay: Flow<Boolean> = context.dataStore.data.map { it[Keys.AUTOPLAY] ?: true }
    suspend fun setAutoplay(enabled: Boolean) {
        context.dataStore.edit { it[Keys.AUTOPLAY] = enabled }
    }

    /** One of: crimson, vapor, tide, pulse, sunset, lagoon, cosmic (see backgrounds.css) — "pulse"
     *  (dark violet/purple) is the default; the old "default" colorway option no longer exists. */
    val colorway: Flow<String> = context.dataStore.data.map { it[Keys.COLORWAY] ?: "pulse" }

    suspend fun setColorway(colorway: String) {
        context.dataStore.edit { it[Keys.COLORWAY] = colorway }
    }

    // Settings > Appearance's "Animate background" toggle + speed slider — js/wavesBg.js reads
    // these once via settings.get and applies them to the already-running wave animation rather
    // than needing to restart it.
    val backgroundAnimationEnabled: Flow<Boolean> = context.dataStore.data.map { it[Keys.BACKGROUND_ANIMATION_ENABLED] ?: true }
    suspend fun setBackgroundAnimationEnabled(enabled: Boolean) {
        context.dataStore.edit { it[Keys.BACKGROUND_ANIMATION_ENABLED] = enabled }
    }

    val backgroundAnimationSpeed: Flow<Float> = context.dataStore.data.map { it[Keys.BACKGROUND_ANIMATION_SPEED] ?: 1f }
    suspend fun setBackgroundAnimationSpeed(speed: Float) {
        context.dataStore.edit { it[Keys.BACKGROUND_ANIMATION_SPEED] = speed.coerceIn(0.25f, 2.5f) }
    }

    /** Settings > Appearance's "Phone Heat Optimization" toggle — cuts backdrop-filter blur
     *  radius hard (base.css) and halves the animated background's redraw rate (wavesBg.js)
     *  when on. Off by default; this is an opt-in trade of visual richness for less GPU/thermal
     *  load, not something to silently force on anyone. */
    val phoneHeatOptimization: Flow<Boolean> = context.dataStore.data.map { it[Keys.PHONE_HEAT_OPTIMIZATION] ?: false }
    suspend fun setPhoneHeatOptimization(enabled: Boolean) {
        context.dataStore.edit { it[Keys.PHONE_HEAT_OPTIMIZATION] = enabled }
    }

    val wifiOnly: Flow<Boolean> = context.dataStore.data.map { it[Keys.WIFI_ONLY] ?: false }

    val audioQuality: Flow<AudioQuality> = context.dataStore.data.map { prefs ->
        prefs[Keys.AUDIO_QUALITY]?.let { runCatching { AudioQuality.valueOf(it) }.getOrNull() } ?: AudioQuality.MEDIUM
    }

    val themeMode: Flow<ThemeMode> = context.dataStore.data.map { prefs ->
        prefs[Keys.THEME_MODE]?.let { runCatching { ThemeMode.valueOf(it) }.getOrNull() } ?: ThemeMode.DARK
    }

    /** Defaults to the "flat" preset, enabled — i.e. audibly a no-op until the user changes it.
     *  presetId null means "use customLevelsJson instead" (only happens once the user has
     *  actually saved a custom curve — a fresh install has neither key set, so it falls back
     *  to "flat" rather than null-with-no-custom-data). */
    val eqConfig: Flow<EqConfig> = context.dataStore.data.map { prefs ->
        val presetId = prefs[Keys.EQ_PRESET_ID]
        val customLevels = prefs[Keys.EQ_CUSTOM_LEVELS]
        EqConfig(
            enabled = prefs[Keys.EQ_ENABLED] ?: true,
            presetId = if (presetId == null && customLevels == null) "flat" else presetId,
            customLevelsJson = customLevels,
        )
    }

    suspend fun currentWifiOnly(): Boolean = wifiOnly.first()
    suspend fun currentAudioQuality(): AudioQuality = audioQuality.first()

    suspend fun setWifiOnly(enabled: Boolean) {
        context.dataStore.edit { it[Keys.WIFI_ONLY] = enabled }
    }

    suspend fun setAudioQuality(quality: AudioQuality) {
        context.dataStore.edit { it[Keys.AUDIO_QUALITY] = quality.name }
    }

    suspend fun setThemeMode(mode: ThemeMode) {
        context.dataStore.edit { it[Keys.THEME_MODE] = mode.name }
    }

    suspend fun setEqEnabled(enabled: Boolean) {
        context.dataStore.edit { it[Keys.EQ_ENABLED] = enabled }
    }

    /** Saves a named preset as the global default and clears any stored custom curve. */
    suspend fun setEqPreset(presetId: String) {
        context.dataStore.edit {
            it[Keys.EQ_PRESET_ID] = presetId
            it.remove(Keys.EQ_CUSTOM_LEVELS)
        }
    }

    /** Saves a custom curve as the global default (presetId becomes null → "custom"). */
    suspend fun setEqCustomLevels(levelsJson: String) {
        context.dataStore.edit {
            it.remove(Keys.EQ_PRESET_ID)
            it[Keys.EQ_CUSTOM_LEVELS] = levelsJson
        }
    }

    /** Used by Account > Wipe Local Data. */
    suspend fun clearAll() {
        context.dataStore.edit { it.clear() }
    }
}
