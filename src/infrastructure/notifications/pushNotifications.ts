import { Linking, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

/**
 * The only place the app touches expo-notifications directly — same pattern
 * as infrastructure/media for expo-audio. UI state lives in
 * ui/screens/settings/NotificationsProvider.tsx.
 */

/** Must match the channel id the server targets (server/src/lib/fcm.ts). */
export const MESSAGES_CHANNEL_ID = 'messages';
/** Security alerts such as new logins — must match SECURITY_CHANNEL_ID in server/src/lib/fcm.ts. */
export const SECURITY_CHANNEL_ID = 'security';

export type NotificationPermission = 'granted' | 'undetermined' | 'denied' | 'blocked';

/** Android 8+ silently drops notifications posted to a channel that doesn't exist, local or FCM. */
export async function ensureMessagesChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(MESSAGES_CHANNEL_ID, {
    name: 'Messages',
    description: 'New messages in your conversations',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 150, 250],
  });
  await Notifications.setNotificationChannelAsync(SECURITY_CHANNEL_ID, {
    name: 'Security alerts',
    description: 'New logins to your account',
    importance: Notifications.AndroidImportance.HIGH,
  });
}

function toPermission(response: { granted: boolean; canAskAgain: boolean; status: unknown }): NotificationPermission {
  if (response.granted) return 'granted';
  if (String(response.status) === 'undetermined') return 'undetermined';
  return response.canAskAgain ? 'denied' : 'blocked';
}

export async function getNotificationPermission(): Promise<NotificationPermission> {
  return toPermission(await Notifications.getPermissionsAsync());
}

/** Shows the OS prompt (Android 13+ POST_NOTIFICATIONS) when it can still be shown. */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  return toPermission(await Notifications.requestPermissionsAsync());
}

export function openNotificationSettings(): void {
  void Linking.openSettings();
}

/**
 * This install's FCM registration token. Fails when the app was built
 * without a Firebase configuration (google-services.json) — the error is
 * returned rather than thrown so the UI can say push is unavailable.
 */
export async function getFcmToken(): Promise<{ token: string } | { error: string }> {
  try {
    const result = await Notifications.getDevicePushTokenAsync();
    if (typeof result.data === 'string' && result.data.length > 0) return { token: result.data };
    return { error: 'The device returned an empty push token.' };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function onPushTokenChanged(listener: (token: string) => void): () => void {
  const subscription = Notifications.addPushTokenListener((token) => {
    if (typeof token.data === 'string' && token.data.length > 0) listener(token.data);
  });
  return () => subscription.remove();
}

let activeConversationId: string | null = null;

/** Set by the open conversation screen so its own incoming messages don't also pop a notification. */
export function setActiveConversation(conversationId: string | null): void {
  activeConversationId = conversationId;
}

function conversationIdOf(data: unknown): string | null {
  const id = (data as { conversationId?: unknown } | null | undefined)?.conversationId;
  return typeof id === 'string' ? id : null;
}

/** How notifications (local, or FCM while the app is open) are presented in the foreground. */
export function configureForegroundPresentation(): void {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const onScreen = conversationIdOf(notification.request.content.data) === activeConversationId && activeConversationId !== null;
      return { shouldShowBanner: !onScreen, shouldShowList: !onScreen, shouldPlaySound: !onScreen, shouldSetBadge: false };
    },
  });
}

/** Posts a message notification on the device itself (no push provider involved). */
export async function presentNewMessageNotification({
  conversationId,
  title,
  body,
}: {
  conversationId: string;
  title: string;
  body: string;
}): Promise<void> {
  if (conversationId === activeConversationId) return;
  await Notifications.scheduleNotificationAsync({
    content: { title, body, data: { type: 'new_message', conversationId } },
    trigger: Platform.OS === 'android' ? { channelId: MESSAGES_CHANNEL_ID } : null,
  });
}

/** Where tapping a notification leads: a conversation, or Settings → Devices for a new-login alert. */
export type NotificationTarget = { kind: 'conversation'; conversationId: string } | { kind: 'devices' };

function targetOf(data: unknown): NotificationTarget | null {
  if ((data as { type?: unknown } | null | undefined)?.type === 'new_login') return { kind: 'devices' };
  const conversationId = conversationIdOf(data);
  return conversationId ? { kind: 'conversation', conversationId } : null;
}

export function addNotificationTapListener(onTarget: (target: NotificationTarget) => void): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const target = targetOf(response.notification.request.content.data);
    if (target) onTarget(target);
  });
  return () => subscription.remove();
}

/** Where the notification that launched the app leads, if any. */
export async function getLaunchNotificationTarget(): Promise<NotificationTarget | null> {
  const response = await Notifications.getLastNotificationResponseAsync();
  return response ? targetOf(response.notification.request.content.data) : null;
}

/**
 * Posts the "New login detected" alert on this device, for a login announced
 * over the realtime socket (connected devices get no push for it). Names the
 * device, location when known, and the time — nothing else.
 */
export async function presentNewLoginNotification({
  deviceName,
  location,
  at,
}: {
  deviceName: string;
  location: string | null;
  at: string;
}): Promise<void> {
  const time = new Date(at);
  const when = Number.isNaN(time.getTime())
    ? ''
    : ` · ${time.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'New login detected',
      body: `${deviceName}${location ? ` · ${location}` : ''}${when}. Tap to review your devices.`,
      data: { type: 'new_login' },
    },
    trigger: Platform.OS === 'android' ? { channelId: SECURITY_CHANNEL_ID } : null,
  });
}
