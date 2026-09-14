package expo.modules.callsession

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import java.io.File

/**
 * Receives the app's Firebase messages (registered above expo-notifications'
 * own service). Call pushes are handled here because they must ring even when
 * the app isn't running; every other message goes to expo-notifications
 * exactly as before.
 */
class CallMessagingService : ExpoFirebaseMessagingService() {
  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    val data = remoteMessage.data
    when (data["type"]) {
      "incoming_call" -> {
        val callId = data["callId"] ?: return
        val conversationId = data["conversationId"] ?: return
        CallNotifications.showIncomingCall(
          applicationContext,
          callId,
          localCallerName(applicationContext, conversationId),
          data["media"] == "video",
        )
      }
      "call_ended" -> CallNotifications.cancelIncomingCall(applicationContext, data["callId"] ?: return)
      else -> super.onMessageReceived(remoteMessage)
    }
  }

  /**
   * The push deliberately names no one; the caller's display name comes from
   * this device's own conversation list (the app's local SQLite cache).
   */
  private fun localCallerName(context: Context, conversationId: String): String? = try {
    val file = File(context.filesDir, "SQLite/mls_chat_cache.db")
    if (!file.exists()) {
      null
    } else {
      SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READONLY).use { db ->
        db.rawQuery("SELECT other_display_name FROM conversations WHERE id = ? LIMIT 1", arrayOf(conversationId)).use { cursor ->
          if (cursor.moveToFirst()) cursor.getString(0) else null
        }
      }
    }
  } catch (_: Exception) {
    null
  }
}
