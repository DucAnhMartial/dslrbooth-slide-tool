import { safeStorage } from 'electron'
import type { SecretEncryptor } from './configStore'

/**
 * The platform key-store adapter — the one small file in `src/electron/` that
 * imports `electron`, kept deliberately thin so `configStore.ts` stays
 * loadable by vitest.
 *
 * Never a hand-rolled cipher (10-RESEARCH's Don't Hand-Roll table): a bespoke
 * wrapper needs a key, and there is nowhere on a booth PC to put one the same
 * attacker cannot also read. `safeStorage` is DPAPI-backed on Windows —
 * "only a user with the same logon credential as the user who encrypted the
 * data can typically decrypt the data" — and it is one call, not a design.
 *
 * `encryptString`/`decryptString` work over `Buffer`; `configStore.ts` only
 * ever sees strings (so it can write plain JSON), so this adapter base64-codes
 * across that boundary and nowhere else.
 */
export function createSafeStorageEncryptor(): SecretEncryptor {
  return {
    isAvailable(): boolean {
      try {
        return safeStorage.isEncryptionAvailable()
      } catch {
        return false
      }
    },
    encrypt(plaintext: string): string {
      return safeStorage.encryptString(plaintext).toString('base64')
    },
    decrypt(ciphertext: string): string {
      return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'))
    },
  }
}
