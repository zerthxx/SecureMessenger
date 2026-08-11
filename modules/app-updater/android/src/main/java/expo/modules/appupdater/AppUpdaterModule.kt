package expo.modules.appupdater

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

/**
 * Native support for the in-app Android update flow: reading the real
 * installed version (from PackageManager, not app.json — this project
 * builds locally via `gradlew`, so app.json's version field is not
 * necessarily kept in sync with what's actually installed), hashing a
 * downloaded APK, checking/requesting the "install unknown apps"
 * permission, and handing a downloaded APK to Android's own package
 * installer.
 *
 * What this module deliberately does NOT do: it never installs
 * anything itself. `installApk` only launches
 * `Intent.ACTION_VIEW` at the system package installer — Android always
 * shows its own Install/Update confirmation UI, and the user must tap
 * Install themselves. There is no API surface here for a silent or
 * unattended install.
 */
class AppUpdaterModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AppUpdater")

    AsyncFunction("getInstalledVersion") {
      val context = appContext.reactContext
        ?: throw CodedException("AppUpdaterError", "No Android context available", null)
      val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
      val versionCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        packageInfo.longVersionCode.toInt()
      } else {
        @Suppress("DEPRECATION")
        packageInfo.versionCode
      }
      mapOf(
        "versionCode" to versionCode,
        "versionName" to (packageInfo.versionName ?: ""),
      )
    }

    // `fileUri` is a plain file:// URI or filesystem path to the
    // downloaded APK in the app's own sandboxed storage (expo-file-system's
    // download destination) — read directly via java.io.File, not through
    // a content:// URI, since this only ever needs to read bytes this
    // process itself just wrote, not hand them to another app.
    AsyncFunction("sha256File") { fileUri: String ->
      val path = if (fileUri.startsWith("file://")) Uri.parse(fileUri).path else fileUri
      if (path.isNullOrEmpty()) {
        throw CodedException("AppUpdaterError", "Invalid file path: $fileUri", null)
      }
      val file = File(path)
      if (!file.exists()) {
        throw CodedException("AppUpdaterError", "File does not exist: $path", null)
      }

      val digest = MessageDigest.getInstance("SHA-256")
      FileInputStream(file).use { input ->
        val buffer = ByteArray(64 * 1024)
        while (true) {
          val read = input.read(buffer)
          if (read < 0) break
          digest.update(buffer, 0, read)
        }
      }
      digest.digest().joinToString("") { "%02x".format(it) }
    }

    AsyncFunction("canRequestPackageInstalls") {
      val context = appContext.reactContext
        ?: throw CodedException("AppUpdaterError", "No Android context available", null)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.packageManager.canRequestPackageInstalls()
      } else {
        // Pre-Oreo: "Unknown sources" was a single device-wide setting,
        // not a per-app grant gated by this permission — treat as
        // already allowed and let the installer UI itself be the source
        // of truth on those old OS versions.
        true
      }
    }

    // Deep-links into this app's specific "Install unknown apps" toggle
    // (not a generic settings screen) so the user sees exactly the
    // switch they need, pre-scoped to this app.
    AsyncFunction("openInstallPermissionSettings") {
      val context = appContext.reactContext
        ?: throw CodedException("AppUpdaterError", "No Android context available", null)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
          data = Uri.parse("package:${context.packageName}")
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
      }
      null
    }

    // `contentUri` must be a content:// URI (e.g. expo-file-system's
    // File.contentUri for the downloaded APK, backed by its own
    // FileProvider) — a file:// URI would be blocked by the platform's
    // FileUriExposedException on API 24+ when handed to another app's
    // component, which is exactly the class of bug FileProvider exists
    // to prevent, so this is enforced here rather than left to fail
    // confusingly downstream.
    AsyncFunction("installApk") { contentUri: String ->
      if (!contentUri.startsWith("content://")) {
        throw CodedException(
          "AppUpdaterError",
          "installApk requires a content:// URI (e.g. from FileProvider), got: $contentUri",
          null,
        )
      }
      val context = appContext.reactContext
        ?: throw CodedException("AppUpdaterError", "No Android context available", null)

      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(Uri.parse(contentUri), "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }

      try {
        context.startActivity(intent)
      } catch (e: Exception) {
        throw CodedException(
          "AppUpdaterError",
          "Could not launch the Android package installer: ${e.message ?: e::class.simpleName}",
          e,
        )
      }
      null
    }
  }
}
