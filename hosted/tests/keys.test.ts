import assert from 'node:assert/strict'
import test from 'node:test'
import { CACHE_TTL_MS, createKeyResolver, hashKey, mintKey, parseKey, requestKey } from '../src/auth/keys.ts'

test('minted keys parse back to their account, including Clerk ids with underscores', () => {
  const key = mintKey('user_2abcDEF')
  assert.deepEqual(parseKey(key), { key, accountId: 'user_2abcDEF' })
  assert.notEqual(mintKey('user_2abcDEF'), key)
})

test('malformed keys are rejected before any lookup', () => {
  const valid = mintKey('user_1')
  for (const key of ['', 'shh', valid.slice(0, -1), valid + 'x', valid.replace('tmk.', 'tmx.'), 'tmk..' + valid.split('.')[2], valid.replace('user_1', 'user.1')]) {
    assert.equal(parseKey(key), null, key)
  }
})

test('hashes are stable hex SHA-256', async () => {
  assert.equal(await hashKey('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('requestKey follows the upstream header precedence', () => {
  const req = (headers: Record<string, string>, query = '') => new Request(`https://hub.example/api/stats${query}`, { headers })
  assert.equal(requestKey(req({ authorization: 'Bearer  a ' }, '?secret=c')), 'a')
  assert.equal(requestKey(req({ 'x-token-monitor-secret': 'b' }, '?secret=c')), 'b')
  assert.equal(requestKey(req({}, '?secret=c')), 'c')
  assert.equal(requestKey(req({ authorization: 'Basic a' })), '')
})

test('the resolver caches verdicts, including rejections, until the TTL', async () => {
  let clock = 0
  const calls: string[] = []
  const resolve = createKeyResolver(async (accountId) => { calls.push(accountId); return accountId === 'good' }, () => clock)
  const good = parseKey(mintKey('good'))!
  const bad = parseKey(mintKey('bad'))!

  assert.equal(await resolve(good), true)
  assert.equal(await resolve(bad), false)
  assert.equal(await resolve(good), true)
  assert.equal(await resolve(bad), false)
  assert.deepEqual(calls, ['good', 'bad'])

  clock += CACHE_TTL_MS
  assert.equal(await resolve(good), true)
  assert.deepEqual(calls, ['good', 'bad', 'good'])
})
