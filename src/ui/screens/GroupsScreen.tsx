import { FlatList, StyleSheet, View } from 'react-native';

import { mockGroups } from '@/data/mock';
import { useTheme } from '@/ui/theme';
import { Divider, GroupRow, IconButton, TopBar } from '@/ui/components';

export function GroupsScreen(): React.JSX.Element {
  const theme = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <TopBar
        title="Groups"
        large
        rightSlot={<IconButton name="add-circle-outline" accessibilityLabel="Create group" onPress={() => {}} />}
      />
      <FlatList
        data={mockGroups}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => (
          <View style={styles.rowPadding}>
            <GroupRow group={item} onPress={() => {}} />
          </View>
        )}
        ItemSeparatorComponent={() => <Divider inset={76} />}
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
