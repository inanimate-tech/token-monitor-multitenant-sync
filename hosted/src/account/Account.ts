import { DurableObject } from 'cloudflare:workers'
import { hashKey, mintKey } from '../auth/keys.ts'

// One per signed-in user, named by Clerk userId. Holds only key hashes, plus the
// user's syndication opt-in. Reached by RPC from the front door (verify) and the
// website's server functions (everything else).
type StoredKey = { id: string; label: string; hash: string; createdAt: string; lastUsedAt: string | null }
export type KeySummary = Omit<StoredKey, 'hash'>

const MAX_KEYS = 20
const LAST_USED_RESOLUTION_MS = 60 * 60 * 1000

export class Account extends DurableObject<Env> {
  private async keys(): Promise<StoredKey[]> {
    return (await this.ctx.storage.get<StoredKey[]>('keys')) ?? []
  }

  async verify(hash: string): Promise<boolean> {
    const keys = await this.keys()
    const key = keys.find((k) => k.hash === hash)
    if (!key) return false
    // Coarse, so verifying does not write on every request.
    const now = Date.now()
    if (!key.lastUsedAt || now - Date.parse(key.lastUsedAt) > LAST_USED_RESOLUTION_MS) {
      key.lastUsedAt = new Date(now).toISOString()
      await this.ctx.storage.put('keys', keys)
    }
    return true
  }

  async listKeys(): Promise<KeySummary[]> {
    return (await this.keys()).map(({ hash: _hash, ...summary }) => summary)
  }

  // Returns the plaintext key once; it is never stored or retrievable again.
  async createKey(accountId: string, label: string): Promise<{ key: string } & KeySummary> {
    // Hash before reading: only storage awaits keep the input gate closed, so the
    // read-modify-write below must not await anything else.
    const key = mintKey(accountId)
    const stored: StoredKey = {
      id: crypto.randomUUID(),
      label: label.trim().slice(0, 60) || 'Untitled',
      hash: await hashKey(key),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    }
    const keys = await this.keys()
    if (keys.length >= MAX_KEYS) throw new Error(`At most ${MAX_KEYS} keys per account`)
    await this.ctx.storage.put('keys', [...keys, stored])
    const { hash: _hash, ...summary } = stored
    return { key, ...summary }
  }

  async revokeKey(id: string): Promise<void> {
    await this.ctx.storage.put('keys', (await this.keys()).filter((k) => k.id !== id))
  }

  async syndication(): Promise<boolean> {
    return (await this.ctx.storage.get<boolean>('syndication')) ?? false
  }

  async setSyndication(enabled: boolean): Promise<void> {
    await this.ctx.storage.put('syndication', enabled === true)
  }
}
