export interface Conversation {
  id: string;
  otherUserId: string;
  otherUsername: string;
  otherDisplayName: string;
  groupJoined: boolean;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  createdAt: string;
}
