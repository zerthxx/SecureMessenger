export interface Chat {
  id: string;
  /** The other person's user id, for direct chats — used to show their photo and open their profile. */
  participantId?: string;
  participantName: string;
  participantOnline: boolean;
  lastMessage: string;
  timestampLabel: string;
  unreadCount: number;
  pinned: boolean;
  muted: boolean;
  isGroup: boolean;
}
