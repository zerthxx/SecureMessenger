package expo.modules.callsession

import android.Manifest
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Runs while a call is connected, so Android keeps the microphone (and the
 * camera, for video) available when the user leaves the app mid-call, and
 * shows the ongoing-call notification.
 */
class CallForegroundService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val callId = intent?.getStringExtra(EXTRA_CALL_ID).orEmpty()
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "SecureMessenger"
    val video = intent?.getBooleanExtra(EXTRA_VIDEO, false) ?: false
    val notification = CallNotifications.ongoingCall(this, callId, title, video)

    var types = 0
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
      if (video && ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
        types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
      }
    }
    try {
      ServiceCompat.startForeground(this, CallNotifications.ONGOING_NOTIFICATION_ID, notification, types)
    } catch (_: Exception) {
      // Not allowed right now (e.g. requested while the app was already in the
      // background). The call itself continues; it just isn't protected when
      // the app is left.
      stopSelf()
    }
    return START_NOT_STICKY
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // Swiping the app away ends the JavaScript that runs the call; don't leave
    // a "call in progress" notification behind.
    stopSelf()
  }

  companion object {
    const val EXTRA_CALL_ID = "callId"
    const val EXTRA_TITLE = "title"
    const val EXTRA_VIDEO = "video"
  }
}
