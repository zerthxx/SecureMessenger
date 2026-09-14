package expo.modules.callsession

import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The native parts of a call that WebRTC doesn't cover: audio routing,
 * ringing, the foreground service that keeps a call alive in the background,
 * the incoming-call notification, and showing the call over the lock screen.
 * Media, encryption and signaling live elsewhere (react-native-webrtc,
 * mls-core, the realtime socket).
 */
class CallSessionModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private var audio: CallAudio? = null
  private var ringer: Ringer? = null

  override fun definition() = ModuleDefinition {
    Name("CallSession")

    Events("onAudioFocusChange")

    OnCreate {
      appContext.reactContext?.let { CallNotifications.ensureChannels(it) }
    }

    OnDestroy {
      audio?.stop()
      ringer?.stop()
    }

    AsyncFunction("startAudio") { speaker: Boolean ->
      val session = audio ?: CallAudio(context) { focused ->
        sendEvent("onAudioFocusChange", mapOf("focused" to focused))
      }.also { audio = it }
      session.start(speaker)
    }

    AsyncFunction("setSpeaker") { on: Boolean ->
      audio?.setSpeaker(on)
      Unit
    }

    AsyncFunction("stopAudio") {
      audio?.stop()
      Unit
    }

    AsyncFunction("startRinging") {
      (ringer ?: Ringer(context).also { ringer = it }).start()
    }

    AsyncFunction("stopRinging") {
      ringer?.stop()
      Unit
    }

    AsyncFunction("startOngoingCall") { callId: String, title: String, video: Boolean ->
      val intent = Intent(context, CallForegroundService::class.java)
        .putExtra(CallForegroundService.EXTRA_CALL_ID, callId)
        .putExtra(CallForegroundService.EXTRA_TITLE, title)
        .putExtra(CallForegroundService.EXTRA_VIDEO, video)
      ContextCompat.startForegroundService(context, intent)
      Unit
    }

    AsyncFunction("stopOngoingCall") {
      context.stopService(Intent(context, CallForegroundService::class.java))
      Unit
    }

    AsyncFunction("showIncomingCall") { callId: String, callerName: String, video: Boolean ->
      CallNotifications.showIncomingCall(context, callId, callerName, video)
    }

    AsyncFunction("dismissIncomingCall") { callId: String ->
      CallNotifications.cancelIncomingCall(context, callId)
    }

    Function("setShowWhenLocked") { show: Boolean ->
      val activity = appContext.currentActivity ?: return@Function Unit
      activity.runOnUiThread {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
          activity.setShowWhenLocked(show)
          activity.setTurnScreenOn(show)
        }
      }
      Unit
    }
  }
}
