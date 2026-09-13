import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { AppState } from 'react-native';
import { router, type Href } from 'expo-router';

import { getApiErrorMessage, notificationsApi } from '@/infrastructure/network/trpcClient';
import {
  addNotificationTapListener,
  configureForegroundPresentation,
  ensureMessagesChannel,
  getFcmToken,
  getLaunchNotificationConversationId,
  getNotificationPermission,
  onPushTokenChanged,
  openNotificationSettings,
  requestNotificationPermission,
  type NotificationPermission,
} from '@/infrastructure/notifications/pushNotifications';
import { getAppState, initMessageStore, setAppState } from '@/infrastructure/storage/messageStore';
import { useAuth } from '@/ui/screens/auth/AuthContext';

const ENABLED_KEY = 'push_notifications_enabled';

export type PushDelivery =
  | { state: 'off' }
  | { state: 'registering' }
  | { state: 'registered'; serverCanDeliver: boolean }
  | { state: 'unavailable'; reason: string };

export interface NotificationsState {
  /** The OS notification permission, re-read whenever the app returns to the foreground. */
  permission: NotificationPermission | 'checking';
  /** The in-app preference (persisted on this device). */
  enabled: boolean;
  /** Notifications are actually on: preference enabled AND the OS allows them. */
  active: boolean;
  /** Whether this install is registered with the server for background push. */
  delivery: PushDelivery;
  setEnabled(next: boolean): Promise<void>;
  openSystemSettings(): void;
  /** Whether the app should post its own notification for an incoming message (i.e. no working server push covers it). */
  shouldPresentLocally(): boolean;
}

const NotificationsContext = createContext<NotificationsState | null>(null);

function readEnabledPreference(): boolean {
  initMessageStore(); // idempotent; app_state lives in the local SQLite store
  return getAppState(ENABLED_KEY) !== '0';
}

export function NotificationsProvider({ children }: PropsWithChildren): React.JSX.Element {
  const { status } = useAuth();
  const signedIn = status === 'authenticated';
  const [permission, setPermission] = useState<NotificationPermission | 'checking'>('checking');
  const [enabled, setEnabledState] = useState(readEnabledPreference);
  const [delivery, setDelivery] = useState<PushDelivery>({ state: 'off' });

  const refreshPermission = useCallback(async () => {
    try {
      setPermission(await getNotificationPermission());
    } catch {
      setPermission('denied');
    }
  }, []);

  useEffect(() => {
    configureForegroundPresentation();
    ensureMessagesChannel().catch(() => {});
    void refreshPermission();
    // The user may change the permission in system settings while the app is in the background.
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refreshPermission();
    });
    return () => subscription.remove();
  }, [refreshPermission]);

  const active = enabled && permission === 'granted';

  // Register this install's push token for the signed-in account while notifications are on.
  useEffect(() => {
    if (!signedIn || !active) {
      setDelivery({ state: 'off' });
      return;
    }
    let cancelled = false;
    const register = async (knownToken?: string) => {
      setDelivery({ state: 'registering' });
      const result = knownToken ? { token: knownToken } : await getFcmToken();
      if (cancelled) return;
      if ('error' in result) {
        setDelivery({ state: 'unavailable', reason: result.error });
        return;
      }
      try {
        const response = await notificationsApi.registerPushToken({ token: result.token, provider: 'fcm' });
        if (!cancelled) setDelivery({ state: 'registered', serverCanDeliver: response.deliveryConfigured });
      } catch (err) {
        if (!cancelled) {
          setDelivery({ state: 'unavailable', reason: getApiErrorMessage(err, 'Could not register this device for notifications.') });
        }
      }
    };
    void register();
    const removeTokenListener = onPushTokenChanged((token) => void register(token));
    return () => {
      cancelled = true;
      removeTokenListener();
    };
  }, [signedIn, active]);

  // Tapping a message notification opens that conversation.
  const launchResponseHandledRef = useRef(false);
  useEffect(() => {
    if (!signedIn) return;
    const openConversation = (conversationId: string) =>
      router.push({ pathname: '/(home)/chats/[id]', params: { id: conversationId } } as unknown as Href);
    if (!launchResponseHandledRef.current) {
      launchResponseHandledRef.current = true;
      getLaunchNotificationConversationId()
        .then((id) => {
          if (id) openConversation(id);
        })
        .catch(() => {});
    }
    return addNotificationTapListener(openConversation);
  }, [signedIn]);

  const setEnabled = useCallback(
    async (next: boolean) => {
      if (!next) {
        setEnabledState(false);
        setAppState(ENABLED_KEY, '0');
        if (signedIn) {
          try {
            await notificationsApi.unregisterPushToken();
          } catch {
            // Best effort: signing out or the next registration also replaces it.
          }
        }
        return;
      }
      setEnabledState(true);
      setAppState(ENABLED_KEY, '1');
      let current = await getNotificationPermission();
      if (current === 'blocked') {
        setPermission(current);
        openNotificationSettings();
        return;
      }
      if (current !== 'granted') {
        current = await requestNotificationPermission();
      }
      setPermission(current);
    },
    [signedIn],
  );

  const latestRef = useRef({ active, delivery });
  latestRef.current = { active, delivery };
  const shouldPresentLocally = useCallback(() => {
    const { active: on, delivery: current } = latestRef.current;
    return on && !(current.state === 'registered' && current.serverCanDeliver);
  }, []);

  const value = useMemo<NotificationsState>(
    () => ({ permission, enabled, active, delivery, setEnabled, openSystemSettings: openNotificationSettings, shouldPresentLocally }),
    [permission, enabled, active, delivery, setEnabled, shouldPresentLocally],
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsState {
  const ctx = useContext(NotificationsContext);
  if (!ctx) {
    throw new Error('useNotifications must be used within a NotificationsProvider');
  }
  return ctx;
}
