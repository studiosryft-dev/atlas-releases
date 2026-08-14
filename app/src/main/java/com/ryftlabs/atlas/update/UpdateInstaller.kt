package com.ryftlabs.atlas.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File

/** Hands a downloaded APK to Android's own package installer — a real update (same package id,
 *  a signature-compatible APK, a higher versionCode), never an uninstall/reinstall. This app
 *  never bypasses the install confirmation UI; it only gets to the point of *launching* it. */
object UpdateInstaller {

    /** API 26+ requires the user to have explicitly allowed this app to install packages
     *  (Settings > Special app access > Install unknown apps) — this permission alone doesn't
     *  grant that, it only lets the app *ask*. Below API 26 there's no per-app toggle. */
    fun canRequestInstall(context: Context): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.packageManager.canRequestPackageInstalls() else true

    fun openInstallPermissionSettings(context: Context) {
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }

    fun install(context: Context, apkFile: File) {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apkFile)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
    }
}
