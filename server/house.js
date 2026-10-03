const DEFAULT_LABELS = {
  lock: { locked: 'Locked', unlocked: 'Unlocked', jammed: 'Jammed', locking: 'Locking', unlocking: 'Unlocking', open: 'Open' },
  cover: { open: 'Open', closed: 'Closed', opening: 'Opening', closing: 'Closing' },
  binary_sensor: { on: 'Open', off: 'Closed' },
};

/**
 * House status, exceptions only: returns the configured entities whose
 * state isn't one of their "normal" states. An entity HA can't reach is
 * reported as "Offline" rather than silently hidden.
 */
export function houseExceptions(houseConfig, states) {
  const out = [];
  for (const item of houseConfig) {
    const st = states.get(item.entity);
    if (!st) continue;
    if (item.normal.includes(st.state)) continue;
    out.push({
      entity: item.entity,
      name: item.name,
      state: st.state,
      label: stateLabel(item, st.state),
    });
  }
  return out;
}

export function stateLabel(item, state) {
  if (state === 'unavailable' || state === 'unknown') return 'Offline';
  if (item.labels && item.labels[state]) return item.labels[state];
  const domain = item.entity.split('.')[0];
  const map = DEFAULT_LABELS[domain];
  if (map && map[state]) return map[state];
  return state.charAt(0).toUpperCase() + state.slice(1).replace(/_/g, ' ');
}

/**
 * "N of M lights on". `lights` null means every light.* entity HA knows
 * about; an explicit list may also name switch.* entities (wall switches).
 */
export function lightCount(lights, states) {
  let on = 0;
  let total = 0;
  for (const [id, st] of states) {
    if (lights ? !lights.includes(id) : !id.startsWith('light.')) continue;
    if (st.state === 'unavailable' || st.state === 'unknown') continue;
    if (st.attributes && Array.isArray(st.attributes.entity_id)) continue; // light groups
    total++;
    if (st.state === 'on') on++;
  }
  return { on, total };
}

export function climateSummary(climate, states) {
  if (!climate) return null;
  const st = states.get(climate.entity);
  if (!st || st.state === 'unavailable') return null;
  const a = st.attributes || {};
  return {
    name: climate.name,
    mode: st.state,
    action: a.hvac_action || null,
    current: typeof a.current_temperature === 'number' ? Math.round(a.current_temperature) : null,
    target: typeof a.temperature === 'number' ? Math.round(a.temperature) : null,
  };
}

/**
 * HA scenes have no on/off; their state is the timestamp of the last
 * activation. The most recently activated configured scene is "current".
 */
export function sceneList(scenes, states) {
  let latest = null;
  const list = scenes.map((s) => {
    const st = states.get(s.entity);
    const at = st && Date.parse(st.state);
    const item = { entity: s.entity, name: s.name, lastActivated: Number.isNaN(at) || !at ? null : new Date(at).toISOString() };
    if (item.lastActivated && (!latest || item.lastActivated > latest.lastActivated)) latest = item;
    return item;
  });
  return { list, current: latest ? latest.entity : null };
}

// States that mean "not running" across the common washer/dryer integrations.
const IDLE_STATES = ['off', 'idle', 'stop', 'stopped', 'end', 'finished', 'finish', 'complete', 'completed',
  'ready', 'standby', 'none', 'pause', 'paused', 'unavailable', 'unknown', '0', 'false'];

/**
 * Appliances that are running right now, with when they'll finish.
 *
 * `remaining` may be a timestamp sensor (finish time, e.g. SmartThings
 * "completion time"), a duration sensor (number + unit, e.g. 23 min), or an
 * "H:MM[:SS]" string. Durations are counted from the sensor's last update so
 * a stale reading still gives the right finish time. `state` (optional)
 * decides whether it's running; without it, a future finish time does.
 */
export function applianceStatus(appliances, states, now = new Date()) {
  const out = [];
  for (const a of appliances) {
    const st = a.state ? states.get(a.state) : null;
    const rem = a.remaining ? states.get(a.remaining) : null;
    const finishesAt = rem ? finishTime(rem, now) : null;

    let running;
    if (st) {
      const v = String(st.state).toLowerCase();
      running = a.runningStates ? a.runningStates.map((x) => String(x).toLowerCase()).includes(v) : !IDLE_STATES.includes(v);
    } else {
      running = !!finishesAt && finishesAt > now;
    }
    if (!running) continue;
    out.push({ name: a.name, finishesAt: finishesAt && finishesAt > now ? finishesAt.toISOString() : null });
  }
  return out;
}

const UNIT_MS = { s: 1e3, sec: 1e3, min: 60e3, h: 3600e3, hr: 3600e3, d: 86400e3 };

export function finishTime(st, now = new Date()) {
  const raw = st.state;
  if (raw == null || raw === 'unavailable' || raw === 'unknown' || raw === '') return null;
  const a = st.attributes || {};
  if (a.device_class === 'timestamp' || /^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    const t = new Date(raw);
    return Number.isNaN(t.getTime()) ? null : t;
  }
  let ms = null;
  if (/^\d+:\d{1,2}(:\d{1,2})?$/.test(raw)) {
    const p = raw.split(':').map(Number);
    ms = p.length === 3 ? ((p[0] * 60 + p[1]) * 60 + p[2]) * 1e3 : (p[0] * 60 + p[1]) * 60e3;
  } else if (!Number.isNaN(Number(raw))) {
    ms = Number(raw) * (UNIT_MS[a.unit_of_measurement] || UNIT_MS.min);
  }
  if (ms == null || ms <= 0) return null;
  const since = Date.parse(st.last_updated || st.last_changed || '') || now.getTime();
  return new Date(since + ms);
}
