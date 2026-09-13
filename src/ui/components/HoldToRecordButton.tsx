import { useEffect, useRef } from 'react';
import { Animated, PanResponder, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@/ui/theme';

/** Leftward drag (px) that cancels a held recording. */
export const SLIDE_TO_CANCEL_DISTANCE = 110;

/** A press has to last this long before recording starts, so brushing the button never records. */
export const HOLD_TO_RECORD_DELAY_MS = 200;

export interface HoldToRecordButtonProps {
  disabled?: boolean;
  recording: boolean;
  /** The press lasted long enough — start recording. */
  onHoldStart: () => void;
  /** The finger lifted while holding (and the recording wasn't cancelled) — send it. */
  onRelease: () => void;
  /** Slid past the cancel distance, or the gesture was interrupted — discard. */
  onCancel: () => void;
  /** Current leftward drag distance in px while holding. */
  onSlide: (distance: number) => void;
  /** A quick tap that never reached the hold delay. */
  onTap: () => void;
  /** Screen-reader activation: toggles recording without a hold gesture. */
  onAccessibilityActivate: () => void;
}

/**
 * The composer's microphone: press and hold to record, release to send,
 * slide left to cancel. Every handler goes through a ref so the single
 * PanResponder (created once) always calls the latest callbacks.
 */
export function HoldToRecordButton(props: HoldToRecordButtonProps): React.JSX.Element {
  const theme = useTheme();
  const propsRef = useRef(props);
  propsRef.current = props;

  const scale = useRef(new Animated.Value(1)).current;
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holding = useRef(false);
  const cancelled = useRef(false);

  const clearHoldTimer = () => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  };

  const endHold = () => {
    holding.current = false;
    Animated.spring(scale, { toValue: 1, useNativeDriver: true }).start();
  };

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !propsRef.current.disabled,
      onMoveShouldSetPanResponder: () => holding.current,
      // Don't let a parent scroll view steal the gesture mid-recording.
      onPanResponderTerminationRequest: () => !holding.current,
      onPanResponderGrant: () => {
        cancelled.current = false;
        clearHoldTimer();
        holdTimer.current = setTimeout(() => {
          holdTimer.current = null;
          holding.current = true;
          Animated.spring(scale, { toValue: 1.3, useNativeDriver: true }).start();
          propsRef.current.onHoldStart();
        }, HOLD_TO_RECORD_DELAY_MS);
      },
      onPanResponderMove: (_event, gesture) => {
        if (!holding.current || cancelled.current) return;
        const distance = Math.max(0, -gesture.dx);
        propsRef.current.onSlide(distance);
        if (distance >= SLIDE_TO_CANCEL_DISTANCE) {
          cancelled.current = true;
          endHold();
          propsRef.current.onCancel();
        }
      },
      onPanResponderRelease: () => {
        if (holdTimer.current) {
          clearHoldTimer();
          propsRef.current.onTap();
          return;
        }
        if (!holding.current) return; // already cancelled by sliding
        endHold();
        propsRef.current.onRelease();
      },
      onPanResponderTerminate: () => {
        clearHoldTimer();
        if (holding.current && !cancelled.current) {
          endHold();
          propsRef.current.onCancel();
        }
      },
    }),
  ).current;

  useEffect(() => clearHoldTimer, []);

  return (
    <View
      {...responder.panHandlers}
      accessible
      accessibilityRole="button"
      accessibilityLabel={props.recording ? 'Send voice message' : 'Record voice message'}
      accessibilityHint="Press and hold to record, release to send, slide left to cancel."
      accessibilityState={{ disabled: !!props.disabled }}
      accessibilityActions={[{ name: 'activate' }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'activate' && !propsRef.current.disabled) {
          propsRef.current.onAccessibilityActivate();
        }
      }}
      style={styles.hitArea}
    >
      <Animated.View
        style={[
          styles.circle,
          {
            backgroundColor: props.recording ? theme.colors.danger : theme.colors.primary,
            opacity: props.disabled ? 0.5 : 1,
            transform: [{ scale }],
          },
        ]}
      >
        <Ionicons name="mic" size={22} color={theme.colors.onPrimary} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  hitArea: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  circle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
