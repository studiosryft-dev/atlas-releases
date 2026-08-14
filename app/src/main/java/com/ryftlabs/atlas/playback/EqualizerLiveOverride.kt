package com.ryftlabs.atlas.playback

import com.ryftlabs.atlas.data.db.EqualizerOwnerType
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * In-process live-preview channel for the Equalizer screen. `PlaybackService` and the UI run
 * in the same process (no separate `android:process` was declared for either service), so a
 * plain singleton is enough — no IPC/custom MediaSession commands needed just to let a drag
 * gesture update playback in real time. Cleared once the edit is saved (persisted values take
 * over) or the screen is left without saving (reverts to whatever's actually persisted).
 */
object EqualizerLiveOverride {

    data class LiveConfig(
        val ownerId: String?,
        val ownerType: EqualizerOwnerType?,
        val enabled: Boolean,
        val presetId: String?,
        val customLevelsJson: String?,
    )

    private val _current = MutableStateFlow<LiveConfig?>(null)
    val current: StateFlow<LiveConfig?> = _current.asStateFlow()

    fun push(config: LiveConfig) {
        _current.value = config
    }

    fun clear() {
        _current.value = null
    }
}
