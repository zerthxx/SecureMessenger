import { useEffect, useState } from 'react';

import { getVoicePlaybackState, subscribeVoicePlayback, type VoicePlaybackState } from '@/infrastructure/media/voicePlayer';

/** Read-only subscription to the singleton voice-message player, scoped to one message id. */
export function useVoicePlaybackState(messageId: string): { playing: boolean; currentTime: number; duration: number } {
  const [state, setState] = useState<VoicePlaybackState>(getVoicePlaybackState);

  useEffect(() => subscribeVoicePlayback(setState), []);

  if (state.messageId !== messageId) {
    return { playing: false, currentTime: 0, duration: 0 };
  }
  return { playing: state.playing, currentTime: state.currentTime, duration: state.duration };
}
