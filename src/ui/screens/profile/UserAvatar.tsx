import { Pressable } from 'react-native';

import { Avatar, type AvatarSize } from '@/ui/components';
import { useAvatarImage } from '@/ui/hooks/useAvatarImage';
import { useUserProfile } from './useUserProfile';

export interface UserAvatarProps {
  userId: string;
  name: string;
  size?: AvatarSize;
  /** Pass when the photo id is already known (e.g. from search results) to skip the profile lookup. */
  avatarId?: string | null;
  /** Makes the avatar a button, typically opening the user's profile. */
  onPress?: () => void;
}

/** Another user's avatar: their profile photo when they have one (cached on device), initials otherwise. */
export function UserAvatar({ userId, name, size, avatarId, onPress }: UserAvatarProps): React.JSX.Element {
  const avatarIdKnown = avatarId !== undefined;
  const { profile } = useUserProfile(avatarIdKnown ? null : userId);
  const imageUri = useAvatarImage(userId, avatarIdKnown ? avatarId : profile?.avatarId);
  const avatar = <Avatar name={name} size={size} imageUri={imageUri} />;

  if (!onPress) return avatar;
  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={`View ${name}'s profile`}
      style={({ pressed }) => (pressed ? { opacity: 0.7 } : null)}
    >
      {avatar}
    </Pressable>
  );
}
