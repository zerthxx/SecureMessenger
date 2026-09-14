import { useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useRouter, type Href } from 'expo-router';

import { getApiErrorMessage } from '@/infrastructure/network/trpcClient';
import { useTheme } from '@/ui/theme';
import { AppText, Divider, EmptyState, TopBar } from '@/ui/components';
import { UserAvatar, useOpenUserProfile } from '@/ui/screens/profile';
import { TextField } from '@/ui/components';
import { useChat } from './ChatContext';

interface UserResult {
  id: string;
  username: string;
  displayName: string;
  avatarId: string | null;
}

export function NewConversationScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { searchUsers, startConversation } = useChat();
  const openUserProfile = useOpenUserProfile();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [startingId, setStartingId] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      return;
    }
    setSearching(true);
    const handle = setTimeout(async () => {
      try {
        const found = await searchUsers(trimmed);
        setResults(found);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [query, searchUsers]);

  async function handleSelect(user: UserResult) {
    if (startingId) return;
    setStartingId(user.id);
    try {
      const conversationId = await startConversation(user.id, user.username, user.displayName);
      // Cast: expo-router's generated route types (.expo/types/router.d.ts)
      // regenerate on the next `expo start`/dev-server run and don't yet
      // list this phase's new `chats/[id]` route — the object form below
      // is the correct, standard runtime API for a dynamic segment
      // regardless; only the compile-time literal-type check is stale.
      router.replace({ pathname: '/(home)/chats/[id]', params: { id: conversationId } } as unknown as Href);
    } catch (err) {
      Alert.alert('Could not start conversation', getApiErrorMessage(err, 'Please try again.'));
    } finally {
      setStartingId(null);
    }
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <TopBar title="New chat" onBack={() => router.back()} />
      <View style={styles.searchWrap}>
        <TextField placeholder="Search by username" leadingIcon="search" value={query} onChangeText={setQuery} autoFocus returnKeyType="search" />
      </View>
      <FlatList
        data={results}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => handleSelect(item)}
            disabled={startingId !== null}
            accessibilityRole="button"
            accessibilityLabel={`Start chat with ${item.displayName}`}
            style={({ pressed }) => [styles.row, pressed || startingId === item.id ? { opacity: 0.6 } : null]}
          >
            {/* Tapping the photo opens their profile; tapping the row starts the chat. */}
            <UserAvatar userId={item.id} avatarId={item.avatarId} name={item.displayName} onPress={() => openUserProfile(item.id)} />
            <View style={styles.textWrap}>
              <AppText variant="bodyMedium">{item.displayName}</AppText>
              <AppText variant="caption" color="secondary">
                @{item.username}
              </AppText>
            </View>
          </Pressable>
        )}
        ItemSeparatorComponent={() => <Divider inset={80} />}
        ListEmptyComponent={
          !query.trim() ? undefined : searching ? undefined : (
            <EmptyState icon="person-outline" title="No users found" message="Check the username and try again." />
          )
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
  searchWrap: {
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  listContent: {
    paddingBottom: 32,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  textWrap: {
    flex: 1,
  },
});
