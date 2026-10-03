import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HomeAssistant } from '../server/ha.js';

const quiet = { log() {}, warn() {}, error() {} };

function fakeFetch(routes, calls) {
  return async (url, opts) => {
    calls.push({ url, ...opts });
    const path = url.replace('http://ha:8123', '');
    const body = routes[`${opts.method} ${path.split('?')[0]}`];
    if (body === undefined) return new Response('nope', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

test('REST calls carry the bearer token and parse forecasts', async () => {
  const calls = [];
  const ha = new HomeAssistant({
    url: 'http://ha:8123',
    token: 'tok',
    log: quiet,
    fetchImpl: fakeFetch({
      'GET /api/states': [{ entity_id: 'light.a', state: 'on' }],
      'POST /api/services/weather/get_forecasts': {
        changed_states: [],
        service_response: { 'weather.home': { forecast: [{ datetime: 'x', temperature: 50 }] } },
      },
      'POST /api/services/scene/turn_on': [],
      'GET /api/calendars/calendar.family': [{ summary: 'A' }],
    }, calls),
  });

  assert.equal((await ha.getStates())[0].entity_id, 'light.a');
  assert.equal(calls[0].headers.Authorization, 'Bearer tok');

  const fc = await ha.getForecast('weather.home', 'hourly');
  assert.equal(fc[0].temperature, 50);
  assert.ok(calls[1].url.endsWith('/api/services/weather/get_forecasts?return_response'));
  assert.deepEqual(JSON.parse(calls[1].body), { entity_id: 'weather.home', type: 'hourly' });

  await ha.turnOnScene('scene.evening');
  assert.deepEqual(JSON.parse(calls[2].body), { entity_id: 'scene.evening' });

  const evs = await ha.getCalendarEvents('calendar.family', new Date('2026-10-03T05:00:00Z'), new Date('2026-10-10T05:00:00Z'));
  assert.equal(evs[0].summary, 'A');
  assert.match(calls[3].url, /start=2026-10-03T05%3A00%3A00\.000Z&end=2026-10-10/);

  await assert.rejects(ha.rest('GET', '/api/missing'), /404/);
});

class FakeWebSocket extends EventTarget {
  static last = null;
  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    FakeWebSocket.last = this;
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.dispatchEvent(new Event('close')); }
  receive(msg) {
    const ev = new Event('message');
    ev.data = JSON.stringify(msg);
    this.dispatchEvent(ev);
  }
}

test('WebSocket: auth, subscribe, state events, reconnect status', () => {
  const ha = new HomeAssistant({ url: 'https://ha.local:8123', token: 'tok', WebSocketImpl: FakeWebSocket, log: quiet });
  const states = [];
  const status = [];
  ha.connect({ onState: (id, st) => states.push([id, st.state]), onStatus: (up) => status.push(up) });
  const ws = FakeWebSocket.last;
  assert.equal(ws.url, 'wss://ha.local:8123/api/websocket');

  ws.receive({ type: 'auth_required' });
  assert.deepEqual(ws.sent[0], { type: 'auth', access_token: 'tok' });
  ws.receive({ type: 'auth_ok' });
  assert.equal(ws.sent[1].type, 'subscribe_events');
  assert.equal(ws.sent[1].event_type, 'state_changed');
  assert.deepEqual(status, []); // not live until HA confirms
  ws.receive({ type: 'result', id: ws.sent[1].id, success: true });
  assert.deepEqual(status, [true]);

  ws.receive({ type: 'event', event: { event_type: 'state_changed', data: { entity_id: 'lock.front', new_state: { state: 'unlocked' } } } });
  assert.deepEqual(states, [['lock.front', 'unlocked']]);

  ha.closed = true; // don't schedule a real reconnect timer
  ws.close();
  assert.deepEqual(status, [true, false]);
});

test('WebSocket: a failed handshake does not recurse (error → close → error)', () => {
  class FailingWebSocket extends FakeWebSocket {
    close() { this.dispatchEvent(new Event('error')); this.dispatchEvent(new Event('close')); }
  }
  const ha = new HomeAssistant({ url: 'http://ha:8123', token: 'tok', WebSocketImpl: FailingWebSocket, log: quiet });
  ha.closed = true;
  ha.connect({ onState() {}, onStatus() {} });
  const ws = FakeWebSocket.last;
  ws.dispatchEvent(new Event('error'));
  ws.close();
  assert.equal(ha.ws, null);
});

test('WebSocket: a refused subscription is logged and never reported as live', () => {
  const errors = [];
  const ha = new HomeAssistant({ url: 'http://ha:8123', token: 'tok', WebSocketImpl: FakeWebSocket, log: { ...quiet, error: (m) => errors.push(m) } });
  const status = [];
  ha.connect({ onState() {}, onStatus: (up) => status.push(up) });
  const ws = FakeWebSocket.last;
  ws.receive({ type: 'auth_required' });
  ws.receive({ type: 'auth_ok' });
  ws.receive({ type: 'result', id: ws.sent[1].id, success: false, error: { code: 'unauthorized', message: 'Unauthorized' } });
  assert.deepEqual(status, []);
  assert.equal(ha.connected, false);
  assert.match(errors[0], /unauthorized/);
});
