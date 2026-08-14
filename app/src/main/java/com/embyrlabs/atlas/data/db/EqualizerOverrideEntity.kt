package com.embyrlabs.atlas.data.db

import kotlinx.serialization.Serializable

@Serializable
enum class EqualizerOwnerType { TRACK, PLAYLIST }

/**
 * Per-track or per-playlist EQ override. `presetId` non-null means "use this named preset";
 * null means custom band levels are stored in `customLevelsJson` instead (a JSON-encoded
 * Map<Int, Short> of band index -> millibel level — band indices are only meaningful against
 * the same device's Equalizer engine, see EqualizerController).
 */
@androidx.room.Entity(tableName = "equalizer_overrides", primaryKeys = ["ownerId", "ownerType"])
@Serializable
data class EqualizerOverrideEntity(
    val ownerId: String,
    val ownerType: EqualizerOwnerType,
    val presetId: String?,
    val customLevelsJson: String?,
    val enabled: Boolean = true,
)
