import { NativeModule, requireNativeModule } from 'expo';

type CallSessionEvents = {
  /** False while another app (for example a phone call) has taken the audio; true when it comes back. */
  onAudioFocusChange: (event: { focused: boolean }) => void;
};

declare class CallSessionModule extends NativeModule<CallSessionEvents> {
  /** Communication audio mode and focus; `speaker` routes to the loudspeaker, otherwise headset or earpiece. */
  startAudio(speaker: boolean): Promise<void>;
  setSpeaker(on: boolean): Promise<void>;
  stopAudio(): Promise<void>;
  /** Ringtone and vibration for an incoming call shown inside the app. */
  startRinging(): Promise<void>;
  stopRinging(): Promise<void>;
  /** Foreground service + ongoing-call notification, so the call survives leaving the app. */
  startOngoingCall(callId: string, title: string, video: boolean): Promise<void>;
  stopOngoingCall(): Promise<void>;
  /** Full-screen incoming-call notification, for when the app isn't on screen. */
  showIncomingCall(callId: string, callerName: string, video: boolean): Promise<void>;
  dismissIncomingCall(callId: string): Promise<void>;
  /** Lets the call screen appear over the lock screen and wake the display. */
  setShowWhenLocked(show: boolean): void;
}

/** See android/src/main/java/expo/modules/callsession/CallSessionModule.kt. */
export default requireNativeModule<CallSessionModule>('CallSession');
