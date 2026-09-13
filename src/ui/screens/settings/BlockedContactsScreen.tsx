import { EmptyState } from '@/ui/components';
import { SettingsScreenFrame } from './SettingsSections';

/**
 * The app has no blocking feature yet — no blocks table and no block/unblock
 * API on the server — so there is never anyone to list. This screen says
 * exactly that instead of pretending a block list exists.
 */
export function BlockedContactsScreen(): React.JSX.Element {
  return (
    <SettingsScreenFrame title="Blocked contacts">
      <EmptyState
        icon="ban-outline"
        title="No blocked contacts"
        message="You haven't blocked anyone. Blocking people isn't available in SecureMessenger yet."
      />
    </SettingsScreenFrame>
  );
}
