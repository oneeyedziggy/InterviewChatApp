import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { type Messages } from '../../types/types';
import { decryptMessageForUser, loadKeys } from '../../utils/gpg';

type UseHomeAutoDecryptArgs = {
  chatValues: Messages;
  username: string;
  setChatValues: Dispatch<SetStateAction<Messages>>;
};

export function useHomeAutoDecrypt({
  chatValues,
  username,
  setChatValues,
}: UseHomeAutoDecryptArgs) {
  // Track attempted decryptions to avoid infinite retries for the same message.
  const decryptionAttemptsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const keys = loadKeys();
    if (!keys || !username) return;

    const decryptPromises: Array<
      Promise<{ room: string; timestamp: number; content: string } | null>
    > = [];

    for (const [room, messages] of Object.entries(chatValues)) {
      for (const msg of messages) {
        const messageKey = `${room}:${msg.timestamp}`;

        if (decryptionAttemptsRef.current.has(messageKey)) {
          continue;
        }

        let hasAccess = false;
        let encryptedData: string | null = null;

        if (
          msg.encryptedFor &&
          keys.username &&
          msg.encryptedFor[keys.username]
        ) {
          hasAccess = true;
          encryptedData = msg.encryptedFor[keys.username];
        } else if (msg.versions && msg.versions.length > 0) {
          const newestVersion = msg.versions[0];
          if (
            newestVersion.encryptedFor &&
            keys.username &&
            newestVersion.encryptedFor[keys.username]
          ) {
            hasAccess = true;
            encryptedData = newestVersion.encryptedFor[keys.username];
          }
        }

        const needsDecryption =
          hasAccess &&
          encryptedData &&
          (!msg.content ||
            msg.content.trim() === '' ||
            msg.content.includes('🔒') ||
            msg.content.includes('[Encrypted message]'));

        if (needsDecryption) {
          decryptionAttemptsRef.current.add(messageKey);

          decryptPromises.push(
            (async () => {
              try {
                console.log(
                  '[AutoDecrypt] ===== AUTO-DECRYPTING MESSAGE =====',
                );
                console.log('[AutoDecrypt] Message timestamp:', msg.timestamp);
                console.log('[AutoDecrypt] User:', keys.username);
                console.log('[AutoDecrypt] Room:', room);
                console.log(
                  '[AutoDecrypt] Encrypted data length:',
                  encryptedData!.length,
                );
                console.log(
                  '[AutoDecrypt] Encrypted data (first 200 chars):',
                  encryptedData!.substring(0, 200),
                );
                const decrypted = await decryptMessageForUser(
                  encryptedData!,
                  keys.privateKey,
                );
                console.log(
                  '[AutoDecrypt] ✓ Decrypted message',
                  msg.timestamp,
                  'content length:',
                  decrypted.length,
                );
                console.log(
                  '[AutoDecrypt] Decrypted content (first 200 chars):',
                  decrypted.substring(0, 200),
                );
                console.log(
                  '[AutoDecrypt] Decrypted content (full):',
                  decrypted,
                );
                return { room, timestamp: msg.timestamp, content: decrypted };
              } catch (error) {
                console.error(
                  '[AutoDecrypt] ✗ Failed to decrypt message',
                  msg.timestamp,
                  ':',
                  error,
                );
                decryptionAttemptsRef.current.delete(messageKey);
                return null;
              }
            })(),
          );
        }
      }
    }

    if (decryptPromises.length > 0) {
      Promise.all(decryptPromises).then((results) => {
        const updates = results.filter(
          (r): r is { room: string; timestamp: number; content: string } =>
            r !== null,
        );
        if (updates.length > 0) {
          setChatValues((prev) => {
            const updated = { ...prev };
            for (const { room, timestamp, content } of updates) {
              if (updated[room]) {
                updated[room] = updated[room].map((m) =>
                  m.timestamp === timestamp ? { ...m, content } : m,
                );
              }
            }
            return updated;
          });
          console.log(
            '[AutoDecrypt] ✓ Finished auto-decrypting',
            updates.length,
            'messages',
          );
        }
      });
    }
  }, [chatValues, username, setChatValues]);
}
