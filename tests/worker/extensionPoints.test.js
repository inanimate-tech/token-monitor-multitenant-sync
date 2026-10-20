'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
require('../helpers/cloudflareWorkers');

function fakeState() {
  const map = new Map();
  return {
    storage: {
      async get(key) { return map.get(key); },
      async put(key, value) { map.set(key, JSON.parse(JSON.stringify(value))); },
      async delete(key) { map.delete(key); },
      async list({ prefix } = {}) {
        const out = new Map();
        for (const [key, value] of map) {
          if (!prefix || key.startsWith(prefix)) out.set(key, value);
        }
        return out;
      }
    }
  };
}

async function workerModule() {
  return import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
}

function ingest(hub, body, headers = { authorization: 'Bearer shh' }) {
  return hub.fetch(new Request('https://hub.example/api/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  }));
}

// Resolves with the next `count` events an observer receives.
function observedHub(HubDO, env, { count = 1, throws = false } = {}) {
  const events = [];
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  class ObservedHub extends HubDO {
    async onIngested(event) {
      events.push(event);
      if (events.length === count) resolve(events);
      if (throws) throw new Error('observer failed');
    }
  }
  return { hub: new ObservedHub(fakeState(), env), done };
}

test('authorize() is the data-route gate a subclass can replace', async () => {
  const { HubDO } = await workerModule();
  class FrontDoorHub extends HubDO {
    async authorize(request) {
      return request.headers.get('x-front-door') === 'ok'
        ? null
        : new Response('refused', { status: 418 });
    }
  }
  const hub = new FrontDoorHub(fakeState(), {});

  assert.equal((await hub.fetch(new Request('https://hub.example/api/stats', {
    headers: { 'x-front-door': 'ok' }
  }))).status, 200);
  assert.equal((await hub.fetch(new Request('https://hub.example/api/stats'))).status, 418);
  assert.equal((await ingest(hub, { deviceId: 'a', today: { totalTokens: 1 } }, { 'x-front-door': 'ok' })).status, 200);
  assert.equal((await hub.fetch(new Request('https://hub.example/api/health'))).status, 200);
});

test('onIngested sees previous and next records for each stored ingest', async () => {
  const { HubDO } = await workerModule();
  const { hub, done } = observedHub(HubDO, { TOKEN_MONITOR_SECRET: 'shh' }, { count: 2 });

  assert.equal((await ingest(hub, { deviceId: 'dev-a', today: { totalTokens: 10 } })).status, 200);
  assert.equal((await ingest(hub, { deviceId: 'dev-a', today: { totalTokens: 25 } })).status, 200);
  const [first, second] = await done;

  assert.equal(first.deviceId, 'dev-a');
  assert.equal(first.previous, null);
  assert.equal(first.next.periods.today.totalTokens, 10);
  assert.equal(second.previous.periods.today.totalTokens, 10);
  assert.equal(second.next.periods.today.totalTokens, 25);
});

test('onIngested is not called for refused ingests', async () => {
  const { HubDO } = await workerModule();
  const { hub, done } = observedHub(HubDO, { TOKEN_MONITOR_SECRET: 'shh' });

  assert.equal((await ingest(hub, { deviceId: 'dev-a' }, { authorization: 'Bearer nope' })).status, 401);
  assert.equal((await ingest(hub, { today: { totalTokens: 1 } })).status, 400);
  assert.equal((await ingest(hub, { deviceId: 'dev-b', today: { totalTokens: 1 } })).status, 200);
  const [event] = await done;
  assert.equal(event.deviceId, 'dev-b');
});

test('a failing observer does not affect the ingest or later requests', async () => {
  const { HubDO } = await workerModule();
  const originalError = console.error;
  console.error = () => {};
  try {
    const { hub, done } = observedHub(HubDO, { TOKEN_MONITOR_SECRET: 'shh' }, { throws: true });
    const response = await ingest(hub, { deviceId: 'dev-a', today: { totalTokens: 5 } });
    assert.equal(response.status, 200);
    await done;
    await new Promise((r) => setTimeout(r, 0));
    const stats = await hub.fetch(new Request('https://hub.example/api/stats', {
      headers: { authorization: 'Bearer shh' }
    }));
    assert.equal(stats.status, 200);
    assert.equal((await stats.json()).periods.today.totalTokens, 5);
  } finally {
    console.error = originalError;
  }
});

test('observers receive records with session text stripped', async () => {
  const { HubDO } = await workerModule();
  const { hub, done } = observedHub(HubDO, { TOKEN_MONITOR_SECRET: 'shh' });
  const withTitles = (totalTokens) => ({
    deviceId: 'dev-a',
    today: {
      totalTokens,
      sessions: { s1: { totalTokens, title: 'secret plan', preview: 'first prompt', firstUserMessage: 'hi' } }
    }
  });

  hub.notifyIngested(withTitles(1), withTitles(2));
  const [event] = await done;

  for (const record of [event.previous, event.next]) {
    const session = record.today.sessions.s1;
    assert.equal(session.title, undefined);
    assert.equal(session.preview, undefined);
    assert.equal(session.firstUserMessage, undefined);
    assert.ok(session.totalTokens > 0);
  }
});
