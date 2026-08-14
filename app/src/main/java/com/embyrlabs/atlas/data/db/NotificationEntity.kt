package com.embyrlabs.atlas.data.db

import androidx.room.Entity
import androidx.room.PrimaryKey
import kotlinx.serialization.Serializable
import java.util.UUID

/**
 * One row in the persistent in-app notification center — every toast the app shows (native- or
 * JS-triggered) is also recorded here so it survives after the toast auto-dismisses. Separate
 * from the ephemeral toast UI itself (js/notifications.js), which just renders one of these the
 * moment it's created.
 */
@Entity(tableName = "notifications")
@Serializable
data class NotificationEntity(
    @PrimaryKey val id: String = UUID.randomUUID().toString(),
    val icon: String = "info",
    val title: String,
    val body: String? = null,
    val createdAt: Long,
    val isRead: Boolean = false,
    /** Structured payload for notification types the UI renders richer than plain title/body —
     *  currently just update-available notifications (icon = "update"), holding the encoded
     *  UpdateInfo JSON so js/screens/notificationCenter.js can render version/size/notes and
     *  wire up the embedded Download Update button. Null for every ordinary notification. */
    val dataJson: String? = null,
)
