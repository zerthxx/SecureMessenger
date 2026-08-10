import { useTheme } from '@/ui/theme';
import { Avatar, type AvatarSize } from './Avatar';

export interface StoryRingProps {
  name: string;
  size?: AvatarSize;
  seen?: boolean;
}

/** Avatar with a ring indicating unseen (accent) vs seen (neutral border) story content. */
export function StoryRing({ name, size = 'lg', seen = false }: StoryRingProps): React.JSX.Element {
  const theme = useTheme();
  return <Avatar name={name} size={size} ringColor={seen ? theme.colors.border : theme.colors.accent} />;
}
