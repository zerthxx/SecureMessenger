import { Alert, FlatList, StyleSheet, View } from 'react-native';

import type { Group } from '@/domain/entities';
import { useTheme } from '@/ui/theme';
import { Divider, EmptyState, GroupRow, IconButton, TopBar } from '@/ui/components';

// Group conversations aren't implemented server-side yet (the e2ee router's
// listConversations explicitly excludes type: 'group', and there is no
// group-creation procedure) — this screen shows a real, honest empty list
// rather than fabricated groups until that backend work lands.
const groups: Group[] = [];

function handleCreateGroup() {
  Alert.alert('Group creation unavailable', 'Creating groups isn’t available in this build yet. This will be enabled in a future update.');
}

export function GroupsScreen(): React.JSX.Element {
  const theme = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <TopBar
        title="Groups"
        large
        rightSlot={<IconButton name="add-circle-outline" accessibilityLabel="Create group" onPress={handleCreateGroup} />}
      />
      <FlatList
        data={groups}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => (
          <View style={styles.rowPadding}>
            <GroupRow group={item} onPress={() => {}} />
          </View>
        )}
        ItemSeparatorComponent={() => <Divider inset={76} />}
        ListEmptyComponent={
          <EmptyState
            icon="people-outline"
            title="No groups yet"
            message="Group chats aren't available in this build yet."
          />
        }
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  listContent: {
    paddingBottom: 32,
    paddingTop: 4,
  },
  rowPadding: {
    paddingHorizontal: 20,
  },
});
