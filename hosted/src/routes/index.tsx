import { SignInButton } from '@clerk/tanstack-react-start'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { createKey, loadAccount, revokeKey } from '../account/api.ts'

export const Route = createFileRoute('/')({ loader: () => loadAccount(), component: Home })

const sourceFile = (path: string) => `${__SOURCE__}/blob/${__COMMIT__}/hosted/src/${path}`

const EXAMPLE_EVENT = {
  type: 'tokens-per-minute',
  at: '2026-10-13T10:00:00.000Z',
  tokensPerMinute: 18400,
  devices: [{ deviceId: 'macbook', tokensPerMinute: 18400 }],
}

function Home() {
  const account = Route.useLoaderData()
  const router = useRouter()
  const [label, setLabel] = useState('')
  const [newKey, setNewKey] = useState<string | null>(null)
  const refresh = () => router.invalidate()

  if (!account) {
    return (
      <>
        <p>
          A hosted <a href="https://github.com/Javis603/token-monitor">Token Monitor</a> sync Hub. Sign in to create a
          key, then point your widgets and agents at this site.
        </p>
        <SignInButton mode="modal" />
      </>
    )
  }

  return (
    <>
      <h2>Keys</h2>
      <p>
        In Token Monitor, open Settings → Multi-device Sync and set the Hub URL to <code>{account.hubUrl}</code> and the
        Secret to a key. For the headless agent, set <code>TOKEN_MONITOR_HUB_URL</code> and{' '}
        <code>TOKEN_MONITOR_SECRET</code>.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault()
          setNewKey(await createKey({ data: label }))
          setLabel('')
          await refresh()
        }}
      >
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label, e.g. work laptop" maxLength={60} />{' '}
        <button>Create key</button>
      </form>
      {newKey && (
        <div>
          <p>Copy this key now. It is not shown again.</p>
          <pre>{newKey}</pre>
        </div>
      )}
      {account.keys.length > 0 && (
        <table>
          <thead>
            <tr><th>Label</th><th>Created</th><th>Last used</th><th /></tr>
          </thead>
          <tbody>
            {account.keys.map((key) => (
              <tr key={key.id}>
                <td>{key.label}</td>
                <td>{key.createdAt.slice(0, 10)}</td>
                <td>{key.lastUsedAt?.slice(0, 10) ?? 'never'}</td>
                <td>
                  <button onClick={async () => { await revokeKey({ data: key.id }); await refresh() }}>Revoke</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>
        <small>
          Only a hash of each key is stored (<a href={sourceFile('account/Account.ts')}>code</a>). A revoked key can keep
          working for up to a minute. A key in a <code>?secret=</code> URL can end up in logs, so give iOS widgets their own key.
        </small>
      </p>

      {account.sink && (
        <>
          <h2>Live tokens per minute</h2>
          <p>
            When something of yours in {account.sink} uses Token Monitor, it subscribes to this account. Until nothing
            there does, each upload from a device sends exactly this, and nothing else (
            <a href={sourceFile('syndication/sink.ts')}>event</a>, <a href={sourceFile('syndication/tokensPerMinute.ts')}>calculation</a>,{' '}
            <a href={sourceFile(`syndication/${account.sink}.ts`)}>destination</a>):
          </p>
          <pre>{JSON.stringify(EXAMPLE_EVENT, null, 2)}</pre>
          <p>
            <small>
              The rate is how many tokens a device used over its last two minutes of uploads, not counting cache
              reads. It is a live rate, so it differs from the widget's average over active time.
            </small>
          </p>
        </>
      )}
    </>
  )
}
