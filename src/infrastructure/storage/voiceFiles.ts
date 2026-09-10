import { Directory, File, Paths } from 'expo-file-system';

/**
 * On-device storage for voice-message audio, namespaced the same way
 * messageStore.ts namespaces its SQLite rows: by the account that owns
 * them (`owner_user_id` there, an `owner` directory segment here). This
 * is what keeps User A's cached voice clips from ever being visible to
 * User B on a shared device even though — per messageStore's own module
 * doc — nothing is deleted on logout. Callers are expected to pass the
 * SAME captured `owner` snapshot (`getMessageStoreOwner()`) they thread
 * through every other store call for a given async operation; this
 * module does not read any global "current owner" itself.
 *
 * Layout: <documentDirectory>/voice/<ownerUserId>/<conversationId>/<id>.m4a
 */

function voiceDirectory(owner: string, conversationId: string): Directory {
  return new Directory(Paths.document, 'voice', owner, conversationId);
}

function ensureVoiceDirectory(owner: string, conversationId: string): Directory {
  const dir = voiceDirectory(owner, conversationId);
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/**
 * Moves a just-recorded file (expo-audio writes to its own cache
 * location, which the OS may purge) into this app's persistent,
 * owner-scoped storage, named by `id` — the local message id, so a sent
 * message's audio file and its messageStore row share one stable
 * identifier for the lifetime of that message. Returns the final `file://`
 * uri to store as `audioLocalUri`.
 */
export async function persistRecording(owner: string, conversationId: string, id: string, recordedUri: string): Promise<string> {
  const dir = ensureVoiceDirectory(owner, conversationId);
  const source = new File(recordedUri);
  const dest = new File(dir, `${id}.m4a`);
  await source.move(dest);
  return dest.uri;
}

/**
 * Writes a downloaded+decrypted voice-message blob to owner-scoped
 * storage, keyed by the server's mediaId. Returns the `file://` uri to
 * store as `audioLocalUri`.
 *
 * Audit note: the caller (ChatContext's `downloadVoiceMessage`) calls
 * this AFTER `decryptMessage` has already consumed that ciphertext's MLS
 * generation secret — per OpenMLS's forward-secrecy design, that secret
 * is erased once used, so a second decrypt attempt on the same
 * ciphertext is not expected to succeed. If this write fails, the
 * caller has no safe way to recover the plaintext short of the sender
 * re-sending the message — there is nothing in this file that can fix
 * that (it would need a change to when/whether the ciphertext is
 * treated as consumed, which is a decrypt-call-usage-contract decision,
 * not a storage bug). This one-retry is a narrow, local mitigation for
 * the most likely real-world trigger (a transient native I/O hiccup),
 * not a fix for a sustained full-disk condition.
 */
export function writeDownloadedAudio(owner: string, conversationId: string, mediaId: string, bytes: Uint8Array): string {
  const dir = ensureVoiceDirectory(owner, conversationId);
  const file = new File(dir, `${mediaId}.m4a`);
  try {
    file.write(bytes);
  } catch {
    dir.create({ intermediates: true, idempotent: true });
    file.write(bytes);
  }
  return file.uri;
}

/** Reads a local audio file's raw bytes (for encrypting/uploading a just-recorded clip). */
export async function readAudioBytes(uri: string): Promise<Uint8Array> {
  return new File(uri).bytes();
}

/** Best-effort delete — used when a recording is cancelled/discarded before sending. Never throws on a missing/already-gone file. */
export function deleteVoiceFile(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Nothing to clean up, or no longer accessible — not actionable.
  }
}
