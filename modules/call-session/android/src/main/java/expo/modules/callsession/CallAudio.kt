package expo.modules.callsession

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.PowerManager
import androidx.annotation.RequiresApi

/**
 * Audio routing for an active call: communication mode, audio focus, the
 * speaker/earpiece choice (a connected headset is preferred over the
 * earpiece), and the proximity sensor that turns the screen off while the
 * phone is held to the ear.
 */
class CallAudio(context: Context, private val onFocusChange: (Boolean) -> Unit) {
  private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    when (change) {
      AudioManager.AUDIOFOCUS_GAIN -> onFocusChange(true)
      AudioManager.AUDIOFOCUS_LOSS, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> onFocusChange(false)
    }
  }
  private var focusRequest: AudioFocusRequest? = null
  private var previousMode = AudioManager.MODE_NORMAL
  private var active = false
  private var proximityLock: PowerManager.WakeLock? = null

  @Synchronized
  fun start(speaker: Boolean) {
    if (!active) {
      previousMode = audioManager.mode
      requestFocus()
      audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
      active = true
    }
    setSpeaker(speaker)
  }

  @Synchronized
  fun setSpeaker(on: Boolean) {
    if (!active) return
    val onEarpiece = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      routeTo(on)
    } else {
      @Suppress("DEPRECATION")
      audioManager.isSpeakerphoneOn = on
      !on && !headsetConnected()
    }
    setProximityLock(onEarpiece)
  }

  @Synchronized
  fun stop() {
    if (!active) return
    setProximityLock(false)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      audioManager.clearCommunicationDevice()
    } else {
      @Suppress("DEPRECATION")
      audioManager.isSpeakerphoneOn = false
    }
    audioManager.mode = previousMode
    abandonFocus()
    active = false
  }

  /** Routes call audio; returns whether it ended up on the earpiece. */
  @RequiresApi(Build.VERSION_CODES.S)
  private fun routeTo(speaker: Boolean): Boolean {
    val devices = audioManager.availableCommunicationDevices
    val preferred = if (speaker) listOf(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) else HEADSET_TYPES + AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
    val device = preferred.firstNotNullOfOrNull { type -> devices.firstOrNull { it.type == type } } ?: return false
    audioManager.setCommunicationDevice(device)
    return device.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
  }

  private fun headsetConnected(): Boolean =
    audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any { it.type in HEADSET_TYPES }

  private fun requestFocus() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build(),
        )
        .setOnAudioFocusChangeListener(focusListener)
        .build()
      audioManager.requestAudioFocus(request)
      focusRequest = request
    } else {
      @Suppress("DEPRECATION")
      audioManager.requestAudioFocus(focusListener, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
    }
  }

  private fun abandonFocus() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
      focusRequest = null
    } else {
      @Suppress("DEPRECATION")
      audioManager.abandonAudioFocus(focusListener)
    }
  }

  private fun setProximityLock(enabled: Boolean) {
    if (enabled) {
      if (proximityLock == null && powerManager.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) {
        proximityLock = powerManager.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "SecureMessenger:call-proximity").apply {
          setReferenceCounted(false)
          acquire(MAX_CALL_MS)
        }
      }
    } else {
      proximityLock?.let { if (it.isHeld) it.release() }
      proximityLock = null
    }
  }

  companion object {
    private const val MAX_CALL_MS = 4 * 60 * 60 * 1000L
    private val HEADSET_TYPES = listOf(
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_USB_HEADSET,
    )
  }
}
