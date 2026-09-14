package expo.modules.callsession

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person

/**
 * Call notifications: the full-screen incoming-call notification (used when
 * the app isn't on screen, including when it was started by a push) and the
 * ongoing-call notification owned by the foreground service. Both open the
 * app's call screen through a `securemessenger://call?callId=…` link.
 */
object CallNotifications {
  private const val INCOMING_CHANNEL_ID = "calls_incoming"
  private const val ONGOING_CHANNEL_ID = "calls_ongoing"
  private const val INCOMING_NOTIFICATION_ID = 7200
  const val ONGOING_NOTIFICATION_ID = 7201
  private const val INCOMING_TAG_PREFIX = "incoming_call:"

  /** Matches the server's ring timeout — the notification disappears on its own after that. */
  private const val RING_TIMEOUT_MS = 45_000L

  private val VIBRATION_PATTERN = longArrayOf(0, 800, 800)

  fun ensureChannels(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    val incoming = NotificationChannel(INCOMING_CHANNEL_ID, "Incoming calls", NotificationManager.IMPORTANCE_HIGH).apply {
      description = "Rings for incoming voice and video calls"
      setSound(
        RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
          .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
          .build(),
      )
      enableVibration(true)
      vibrationPattern = VIBRATION_PATTERN
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    }
    val ongoing = NotificationChannel(ONGOING_CHANNEL_ID, "Ongoing calls", NotificationManager.IMPORTANCE_LOW).apply {
      description = "Shown while a call is in progress"
      setSound(null, null)
    }
    manager.createNotificationChannels(listOf(incoming, ongoing))
  }

  /** Opens the call screen for `callId`; `action` is "accept", "decline", "hangup", or null to just show it. */
  private fun callScreenIntent(context: Context, callId: String, action: String?, requestCode: Int): PendingIntent {
    val uri = Uri.Builder()
      .scheme("securemessenger")
      .authority("call")
      .appendQueryParameter("callId", callId)
      .apply { if (action != null) appendQueryParameter("action", action) }
      .build()
    val intent = (context.packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent()).apply {
      setAction(Intent.ACTION_VIEW)
      removeCategory(Intent.CATEGORY_LAUNCHER)
      data = uri
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
    return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  fun showIncomingCall(context: Context, callId: String, callerName: String?, video: Boolean) {
    ensureChannels(context)
    val name = callerName?.takeIf { it.isNotBlank() } ?: "SecureMessenger"
    val caller = Person.Builder().setName(name).setImportant(true).build()
    val base = callId.hashCode()
    val open = callScreenIntent(context, callId, null, base)
    val answer = callScreenIntent(context, callId, "accept", base + 1)
    val decline = callScreenIntent(context, callId, "decline", base + 2)

    val notification = NotificationCompat.Builder(context, INCOMING_CHANNEL_ID)
      .setSmallIcon(android.R.drawable.sym_call_incoming)
      .setContentTitle(name)
      .setContentText(if (video) "Incoming video call" else "Incoming voice call")
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOngoing(true)
      .setAutoCancel(false)
      .setTimeoutAfter(RING_TIMEOUT_MS)
      .setContentIntent(open)
      .setFullScreenIntent(open, true)
      .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, answer).setIsVideo(video))
      .build()
    notification.flags = notification.flags or Notification.FLAG_INSISTENT

    try {
      NotificationManagerCompat.from(context).notify(INCOMING_TAG_PREFIX + callId, INCOMING_NOTIFICATION_ID, notification)
    } catch (_: SecurityException) {
      // Notifications not allowed — the call can still be answered from inside the app.
    }
  }

  fun cancelIncomingCall(context: Context, callId: String) {
    NotificationManagerCompat.from(context).cancel(INCOMING_TAG_PREFIX + callId, INCOMING_NOTIFICATION_ID)
  }

  fun ongoingCall(context: Context, callId: String, title: String, video: Boolean): Notification {
    ensureChannels(context)
    val person = Person.Builder().setName(title).build()
    val base = callId.hashCode()
    return NotificationCompat.Builder(context, ONGOING_CHANNEL_ID)
      .setSmallIcon(android.R.drawable.sym_call_outgoing)
      .setContentTitle(title)
      .setContentText(if (video) "Video call in progress" else "Voice call in progress")
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setOngoing(true)
      .setUsesChronometer(true)
      .setContentIntent(callScreenIntent(context, callId, null, base + 3))
      .setStyle(NotificationCompat.CallStyle.forOngoingCall(person, callScreenIntent(context, callId, "hangup", base + 4)).setIsVideo(video))
      .build()
  }
}

/** Rings (and vibrates) for an incoming call while the app itself is on screen. */
class Ringer(private val context: Context) {
  private var ringtone: Ringtone? = null
  private var vibrating = false

  @Synchronized
  fun start() {
    if (ringtone?.isPlaying == true || vibrating) return
    val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    if (audioManager.ringerMode == AudioManager.RINGER_MODE_NORMAL) {
      ringtone = RingtoneManager.getRingtone(context, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE))?.apply {
        audioAttributes = AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
          .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
          .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) isLooping = true
        play()
      }
    }
    if (audioManager.ringerMode != AudioManager.RINGER_MODE_SILENT) {
      val vibrator = context.getSystemService(Vibrator::class.java)
      if (vibrator != null && vibrator.hasVibrator()) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          vibrator.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 800, 800), 0))
        } else {
          @Suppress("DEPRECATION")
          vibrator.vibrate(longArrayOf(0, 800, 800), 0)
        }
        vibrating = true
      }
    }
  }

  @Synchronized
  fun stop() {
    ringtone?.stop()
    ringtone = null
    if (vibrating) {
      context.getSystemService(Vibrator::class.java)?.cancel()
      vibrating = false
    }
  }
}
