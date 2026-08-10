import type { Chat } from '@/domain/entities';

export const mockChats: Chat[] = [
  { id: 'c1', participantName: 'Elena Voss', participantOnline: true, lastMessage: 'Sent the files, let me know when you get them', timestampLabel: '2m', unreadCount: 2, pinned: true, muted: false, isGroup: false },
  { id: 'c2', participantName: 'Marcus Chen', participantOnline: true, lastMessage: 'Sounds good, see you then 👍', timestampLabel: '18m', unreadCount: 0, pinned: true, muted: false, isGroup: false },
  { id: 'c3', participantName: 'Product Team', participantOnline: false, lastMessage: 'Priya: Standup moved to 10am tomorrow', timestampLabel: '41m', unreadCount: 5, pinned: false, muted: false, isGroup: true },
  { id: 'c4', participantName: 'Sofia Reyes', participantOnline: false, lastMessage: 'Haha yes exactly that', timestampLabel: '1h', unreadCount: 0, pinned: false, muted: false, isGroup: false },
  { id: 'c5', participantName: 'Dad', participantOnline: true, lastMessage: 'Call me when you have a sec', timestampLabel: '2h', unreadCount: 1, pinned: false, muted: false, isGroup: false },
  { id: 'c6', participantName: 'Weekend Trip 🏔️', participantOnline: false, lastMessage: 'You: I can drive, have room for 3', timestampLabel: '3h', unreadCount: 0, pinned: false, muted: true, isGroup: true },
  { id: 'c7', participantName: 'Amir Khalil', participantOnline: false, lastMessage: 'Voice message · 0:42', timestampLabel: '5h', unreadCount: 0, pinned: false, muted: false, isGroup: false },
  { id: 'c8', participantName: 'Nadia Petrova', participantOnline: true, lastMessage: 'Typing…', timestampLabel: '6h', unreadCount: 0, pinned: false, muted: false, isGroup: false },
  { id: 'c9', participantName: 'Design Crit', participantOnline: false, lastMessage: 'Tom: Left comments on the new flow', timestampLabel: 'Yesterday', unreadCount: 0, pinned: false, muted: true, isGroup: true },
  { id: 'c10', participantName: 'Jonas Weber', participantOnline: false, lastMessage: 'Thanks for the recommendation!', timestampLabel: 'Yesterday', unreadCount: 0, pinned: false, muted: false, isGroup: false },
  { id: 'c11', participantName: 'Lin Yu', participantOnline: false, lastMessage: 'Photo', timestampLabel: 'Mon', unreadCount: 0, pinned: false, muted: false, isGroup: false },
  { id: 'c12', participantName: 'Book Club', participantOnline: false, lastMessage: 'Grace: Next one is 340 pages, we can do it', timestampLabel: 'Sun', unreadCount: 3, pinned: false, muted: false, isGroup: true },
];
