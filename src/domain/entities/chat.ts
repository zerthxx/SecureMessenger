export interface Chat {
  id: string;
  participantName: string;
  participantOnline: boolean;
  lastMessage: string;
  timestampLabel: string;
  unreadCount: number;
  pinned: boolean;
  muted: boolean;
  isGroup: boolean;
}
