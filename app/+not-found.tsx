import { StyleSheet, Text, View } from 'react-native';

export default function NotFoundScreen(): React.JSX.Element {
  return (
    <View style={styles.container}>
      <Text>This screen does not exist.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
