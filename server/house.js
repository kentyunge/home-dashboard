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

/** "N of M lights on". `lights` null means every light.* entity HA knows about. */
export function lightCount(lights, states) {
  let on = 0;
  let total = 0;
  for (const [id, st] of states) {
    if (!id.startsWith('light.')) continue;
    if (lights && !lights.includes(id)) continue;
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
