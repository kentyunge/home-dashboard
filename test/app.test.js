import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { loadConfig } from '../server/config.js';
import { MockHomeAssistant } from '../server/mock.js';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';

const quiet = { log() {}, warn() {}, error() {} };

async function startServer(env = {}) {
  const config = loadConfig({ MOCK: '1', ...env });
  const source = new MockHomeAssistant(config);
  const store = new Store(config, source, { log: quiet });
  await store.start();
  const server = createServer(createApp({ config, store }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { config, store, server, base, close: () => { store.stop(); server.closeAllConnections(); server.close(); } };
}

let s;
before(async () => { s = await startServer(); });
after(() => s.close());

test('snapshot has calendars, events, weather, scenes, house', async () => {
  const res = await fetch(`${s.base}/api/snapshot`);
  assert.equal(res.status, 200);
  const snap = await res.json();
  assert.equal(snap.mock, true);
  assert.equal(snap.calendars.length, 6);
  assert.ok(snap.events.length > 5);
  assert.ok(snap.weather && snap.weather.hourly.length === 5);
  assert.equal(snap.scenes.length, 4);
  assert.equal(snap.house.length, 1);
  assert.equal(snap.appliances.length, 1);
  assert.equal(snap.appliances[0].name, 'Dryer');
  assert.equal(snap.lights.total, 9);
  // busy-only calendar never leaks titles
  const work = snap.events.filter((e) => e.cal === 'calendar.kent_work');
  assert.ok(work.length > 0);
  assert.ok(work.every((e) => e.title === 'Busy' && !e.location && !e.description));
});

test('scene activation: configured scene ok, others refused', async () => {
  let res = await fetch(`${s.base}/api/scenes/scene.all_off`, { method: 'POST' });
  assert.equal(res.status, 204);
  assert.equal(s.store.snapshot().lights.on, 0);
  assert.equal(s.store.snapshot().currentScene, 'scene.all_off');

  res = await fetch(`${s.base}/api/scenes/scene.not_configured`, { method: 'POST' });
  assert.equal(res.status, 404);
  res = await fetch(`${s.base}/api/scenes/light.kitchen`, { method: 'POST' });
  assert.equal(res.status, 404);
  res = await fetch(`${s.base}/api/scenes/scene.all_off`);
  assert.equal(res.status, 404);
});

test('static files and path traversal', async () => {
  let res = await fetch(`${s.base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /<main id="day"/);

  res = await fetch(`${s.base}/js/app.js`);
  assert.match(res.headers.get('content-type'), /javascript/);

  res = await fetch(`${s.base}/%2e%2e/package.json`);
  assert.equal(res.status, 404);
  res = await fetch(`${s.base}/..%2fserver%2fconfig.js`);
  assert.equal(res.status, 404);
});

test('SSE stream sends a snapshot immediately', async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${s.base}/api/stream`, { signal: ctrl.signal });
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) {
    const { value } = await reader.read();
    text += new TextDecoder().decode(value);
  }
  ctrl.abort();
  assert.match(text, /^event: snapshot\ndata: \{/);
});

test('ACCESS_KEY gate: 401, then ?key sets a cookie', async () => {
  const gated = await startServer({ ACCESS_KEY: 'hunter2' });
  try {
    let res = await fetch(`${gated.base}/api/snapshot`);
    assert.equal(res.status, 401);
    res = await fetch(`${gated.base}/?key=wrong`, { redirect: 'manual' });
    assert.equal(res.status, 401);
    res = await fetch(`${gated.base}/?key=hunter2`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    assert.equal(res.headers.get('location'), '/');
    res = await fetch(`${gated.base}/api/snapshot`, { headers: { cookie } });
    assert.equal(res.status, 200);
    res = await fetch(`${gated.base}/healthz`);
    assert.equal(res.status, 200);
  } finally {
    gated.close();
  }
});

test('config: HA_URL without HA_TOKEN is an error', () => {
  assert.throws(() => loadConfig({ HA_URL: 'http://ha:8123', CONFIG_PATH: 'config/dashboard.example.json' }), /HA_TOKEN/);
});
