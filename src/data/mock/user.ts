import type { User } from '@/domain/entities';

export const mockCurrentUser: User = {
  id: 'me',
  name: 'Jordan Ellis',
  handle: '@jordan',
  online: true,
  lastSeenLabel: 'Online',
  bio: 'Here for the conversations that matter. No trackers, no noise.',
};
