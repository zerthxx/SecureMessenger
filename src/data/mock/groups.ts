import type { Group } from '@/domain/entities';

export const mockGroups: Group[] = [
  { id: 'g1', name: 'Product Team', memberCount: 12, lastActivityLabel: '41m ago', unreadCount: 5, isPrivate: true },
  { id: 'g2', name: 'Weekend Trip 🏔️', memberCount: 6, lastActivityLabel: '3h ago', unreadCount: 0, isPrivate: true },
  { id: 'g3', name: 'Design Crit', memberCount: 9, lastActivityLabel: 'Yesterday', unreadCount: 0, isPrivate: true },
  { id: 'g4', name: 'Book Club', memberCount: 18, lastActivityLabel: 'Sunday', unreadCount: 3, isPrivate: false },
  { id: 'g5', name: 'Neighborhood Watch', memberCount: 214, lastActivityLabel: '2 days ago', unreadCount: 0, isPrivate: false },
  { id: 'g6', name: 'Family', memberCount: 5, lastActivityLabel: '2 days ago', unreadCount: 0, isPrivate: true },
];
