import { FlatList, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { mockStories } from '@/data/mock';
import type { Story } from '@/domain/entities';
import { useTheme } from '@/ui/theme';
import { Avatar, AppText, StoryRing, TopBar } from '@/ui/components';

function StoryTile({ story }: { story: Story }): React.JSX.Element {
  const theme = useTheme();
  const isOwn = story.authorName === 'Your Story';

  return (
    <View style={styles.tile}>
      <View>
        {isOwn ? (
          <Avatar name={story.authorName} size="xl" ringColor={theme.colors.border} />
        ) : (
          <StoryRing name={story.authorName} seen={story.seen} size="xl" />
        )}
        {isOwn ? (
          <View style={[styles.addBadge, { backgroundColor: theme.colors.accent, borderColor: theme.colors.background }]}>
            <Ionicons name="add" size={14} color={theme.colors.onAccent} />
          </View>
        ) : null}
      </View>
      <AppText variant="caption" numberOfLines={1} style={styles.tileLabel}>
        {isOwn ? 'Your Story' : story.authorName.split(' ')[0]}
      </AppText>
      <AppText variant="caption" color="tertiary">
        {isOwn ? '' : story.timestampLabel}
      </AppText>
    </View>
  );
}

export function StoriesScreen(): React.JSX.Element {
  const theme = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <TopBar title="Stories" large />
      <FlatList
        data={mockStories}
        keyExtractor={(item) => item.id}
        numColumns={3}
        contentContainerStyle={styles.gridContent}
        renderItem={({ item }) => <StoryTile story={item} />}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  gridContent: {
    paddingHorizontal: 12,
    paddingBottom: 32,
  },
  tile: {
    flex: 1 / 3,
    alignItems: 'center',
    gap: 4,
    paddingVertical: 16,
  },
  addBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileLabel: {
    maxWidth: 84,
  },
});
