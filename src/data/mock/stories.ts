import type { Story } from '@/domain/entities';

export const mockStories: Story[] = [
  { id: 's1', authorName: 'Your Story', seen: true, timestampLabel: 'Add', segmentCount: 0 },
  { id: 's2', authorName: 'Elena Voss', seen: false, timestampLabel: '12m', segmentCount: 4 },
  { id: 's3', authorName: 'Marcus Chen', seen: false, timestampLabel: '34m', segmentCount: 2 },
  { id: 's4', authorName: 'Sofia Reyes', seen: false, timestampLabel: '1h', segmentCount: 6 },
  { id: 's5', authorName: 'Amir Khalil', seen: true, timestampLabel: '3h', segmentCount: 1 },
  { id: 's6', authorName: 'Nadia Petrova', seen: true, timestampLabel: '5h', segmentCount: 3 },
  { id: 's7', authorName: 'Jonas Weber', seen: false, timestampLabel: '7h', segmentCount: 2 },
  { id: 's8', authorName: 'Lin Yu', seen: true, timestampLabel: '9h', segmentCount: 1 },
];
