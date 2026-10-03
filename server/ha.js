/**
 * Home Assistant client: REST for snapshots and the one allowed write
 * (scene.turn_on), WebSocket for live state_changed events.
 *
 * The same interface is implemented by mock.js so the rest of the server
 * doesn't care which one it's talking to.
 */
export class HomeAssistant {
  constructor({ url, token, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket, log = console }) {
    this.url = url;
    this.token = token;
    this.fetch = fetchImpl;
    this.WebSocket = WebSocketImpl;
    this.log = log;
    this.ws = null;
    this.connected = false;
    this.closed = false;
    this.retryMs = 1000;
  }

  async rest(method, path, body) {
    const res = await this.fetch(this.url + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HA ${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
    }
    const type = res.headers.get('content-type') || '';
    return type.includes('json') ? res.json() : res.text();
  }

  getStates() {
    return this.rest('GET', '/api/states');
  }

  getCalendarEvents(entity, start, end) {
    const q = new URLSearchParams({ start: start.toISOString(), end: end.toISOString() });
    return this.rest('GET', `/api/calendars/${encodeURIComponent(entity)}?${q}`);
  }

  async getForecast(entity, type) {
    const res = await this.rest('POST', '/api/services/weather/get_forecasts?return_response', {
      entity_id: entity,
      type,
    });
    const entry = res && res.service_response && res.service_response[entity];
    return (entry && entry.forecast) || [];
  }

  turnOnScene(entity) {
    return this.rest('POST', '/api/services/scene/turn_on', { entity_id: entity });
  }

  /**
   * Open the WebSocket and call onState(entityId, newState) for every
   * state change. onStatus(connected) fires on connect/disconnect so the
   * caller can refetch everything after a reconnect.
   */
  connect({ onState, onStatus }) {
    if (!this.WebSocket) {
      this.log.warn('No WebSocket implementation available; live updates disabled');
      return;
    }
    const wsUrl = this.url.replace(/^http/, 'ws') + '/api/websocket';
    const ws = new this.WebSocket(wsUrl);
    this.ws = ws;
    let nextId = 1;

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      if (msg.type === 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', access_token: this.token }));
      } else if (msg.type === 'auth_ok') {
        ws.send(JSON.stringify({ id: nextId++, type: 'subscribe_events', event_type: 'state_changed' }));
        this.connected = true;
        this.retryMs = 1000;
        onStatus(true);
      } else if (msg.type === 'auth_invalid') {
        this.log.error('HA WebSocket auth rejected — check HA_TOKEN');
        ws.close();
      } else if (msg.type === 'event' && msg.event && msg.event.event_type === 'state_changed') {
        const { entity_id: id, new_state: state } = msg.event.data;
        onState(id, state);
      }
    });

    const reconnect = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.connected) {
        this.connected = false;
        onStatus(false);
      }
      if (this.closed) return;
      const delay = this.retryMs;
      this.retryMs = Math.min(this.retryMs * 2, 60000);
      this.log.warn(`HA WebSocket closed; reconnecting in ${delay / 1000}s`);
      setTimeout(() => this.connect({ onState, onStatus }), delay).unref();
    };
    ws.addEventListener('close', reconnect);
    // Don't call ws.close() here: on a failed handshake that re-fires 'error'
    // and recurses. reconnect() drops this socket; a late 'close' is ignored.
    ws.addEventListener('error', reconnect);
  }

  close() {
    this.closed = true;
    if (this.ws) this.ws.close();
  }
}
