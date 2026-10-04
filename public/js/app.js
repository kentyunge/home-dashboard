import { h, replace, svgIcon } from './dom.js';
import { weatherIcon } from './icons.js';
import { createDisplay } from './display.js';
import {
  addDays, agendaTime, clockParts, dayName, eventEnd, eventStart, fmtDateLong, fmtHour, fmtRange,
  fmtTime, fmtTimeShort, groupByDay, headsUpWhen, nextEvent, relLabel, startOfDay, whenLabel,
} from './format.js';

const HIDDEN_KEY = 'dashboard.hiddenCalendars';
const OFFLINE_AFTER_MS = 30e3;
const CAMERA_REFRESH_MS = 2000;
const CAMERA_MANUAL_CLOSE_MS = 120e3; // a view someone opened closes itself after 2 min
const CAMERA_ICON = [
  ['path', { d: 'M3 7.5A1.5 1.5 0 0 1 4.5 6h2l1.5-2h8l1.5 2h2A1.5 1.5 0 0 1 21 7.5v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z', stroke: 'currentColor' }],
  ['circle', { cx: 12, cy: 12.5, r: 3.5, stroke: 'currentColor' }],
];

const state = {
  snap: null,
  hidden: new Set(loadHidden()),
  selectedId: null,
  pendingScene: null,
  sceneError: null,
  streamDownSince: null,
  display: null,
  camera: null, // { entity, refreshTimer, closeTimer }
  seenAlerts: new Set(),
};

const $ = (id) => document.getElementById(id);

// ---------- Data ----------

async function start() {
  try {
    const res = await fetch('api/snapshot', { cache: 'no-store' });
    if (res.ok) applySnapshot(await res.json());
  } catch (err) {
    console.warn('Initial snapshot failed', err);
  }
  openStream();
  scheduleMinuteTick();
}

function openStream() {
  const es = new EventSource('api/stream');
  es.addEventListener('snapshot', (e) => {
    state.streamDownSince = null;
    applySnapshot(JSON.parse(e.data));
  });
  es.addEventListener('error', () => {
    // EventSource reconnects by itself; just note when we lost it.
    if (!state.streamDownSince) state.streamDownSince = Date.now();
    renderStatus();
  });
}

function applySnapshot(snap) {
  // A new server build: reload so the kiosk picks up new code.
  if (state.snap && snap.version !== state.snap.version) {
    location.reload();
    return;
  }
  state.snap = snap;
  if (!state.display) {
    state.display = createDisplay({
      getSettings: () => state.snap.settings,
      onMode: setMode,
      onIdle: () => {
        // Back to a clean default after nobody has touched it for a while.
        state.selectedId = null;
        $('agenda').scrollTop = 0;
        render();
      },
    });
  }
  render();
  checkCameraAlerts(snap);
}

function scheduleMinuteTick() {
  const now = new Date();
  const ms = 60e3 - (now.getSeconds() * 1e3 + now.getMilliseconds()) + 50;
  setTimeout(() => {
    render();
    scheduleMinuteTick();
  }, ms);
}

function setMode(mode) {
  const night = mode === 'night';
  $('day').hidden = night;
  $('night').hidden = !night;
  document.body.classList.toggle('is-night', night);
  if (state.snap) render();
}

function loadHidden() {
  try {
    return JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveHidden() {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...state.hidden]));
  } catch { /* storage unavailable; filters just won't persist */ }
}

// ---------- Rendering ----------

function render() {
  const snap = state.snap;
  if (!snap) return;
  const now = new Date();
  const h24 = snap.settings.clock24h;
  const cals = new Map(snap.calendars.map((c) => [c.id, c]));
  const visible = snap.events.filter((e) => !state.hidden.has(e.cal) && cals.has(e.cal));
  const ctx = { snap, now, h24, cals, visible };

  if (document.body.classList.contains('is-night')) {
    renderNight(ctx);
  } else {
    renderClock(ctx);
    renderWeather(ctx);
    renderHome(ctx);
    renderChips(ctx);
    renderAgenda(ctx);
    renderDetail(ctx);
    renderHeadsUp(ctx);
  }
  renderStatus();
}

function renderClock({ now, h24 }) {
  const p = clockParts(now, h24);
  $('clock-time').textContent = p.time;
  $('clock-ampm').textContent = p.ampm;
  $('clock-date').textContent = fmtDateLong(now);
}

function renderWeather({ snap, h24 }) {
  const w = snap.weather;
  const el = $('weather');
  el.hidden = !w;
  if (!w) return;
  const hl = [w.high != null ? `H ${w.high}°` : null, w.low != null ? `L ${w.low}°` : null].filter(Boolean).join(' · ');
  replace(el,
    h('div', { class: 'weather-now' },
      weatherIcon(w.condition),
      h('div', { class: 'weather-temp' }, w.temperature != null ? `${w.temperature}°` : '--'),
      h('div', { class: 'weather-desc' },
        h('span', { class: 'label' }, w.label),
        hl && h('span', { class: 'muted' }, hl))),
    w.hourly.length > 0 && h('div', { class: 'hourly' },
      w.hourly.map((x) => h('div', null,
        h('span', { class: 't' }, fmtHour(new Date(x.time), h24)),
        h('span', { class: 'v' }, x.temperature != null ? `${x.temperature}°` : '')))),
    w.headsUp && h('div', { class: 'weather-headsup' }, weatherHeadsUpText(w.headsUp, h24)),
  );
}

function weatherHeadsUpText(hu, h24) {
  if (hu.kind === 'freeze') {
    return `Freezing after ${fmtTimeShort(new Date(hu.at), h24)} · ${hu.temperature}°`;
  }
  return hu.at ? `${hu.label} likely after ${fmtTimeShort(new Date(hu.at), h24)}` : `${hu.label} now`;
}

function renderHome({ snap }) {
  const rows = [];
  if (snap.climate) {
    const c = snap.climate;
    const active = c.action === 'heating' || c.action === 'cooling';
    const value = c.current != null && c.target != null && active && c.current !== c.target
      ? `${c.current}° → ${c.target}°`
      : c.current != null ? `${c.current}°` : c.mode;
    rows.push(statusRow(c.name, value, 'ok'));
  }
  for (const a of snap.appliances || []) rows.push(statusRow(a.name, applianceText(a, new Date()), 'run'));
  for (const x of snap.house) rows.push(statusRow(x.name, x.label, 'warn'));
  if (!snap.house.length && snap.houseTotal) rows.push(statusRow('Doors & locks', 'All secure', 'ok'));

  const lights = snap.lights.total
    ? `${snap.lights.on} of ${snap.lights.total} lights on`
    : '';

  replace($('home'),
    h('div', { class: 'card-head' },
      h('h2', { class: 'h-card' }, 'Home'),
      h('span', { class: 'muted' }, lights)),
    rows.length > 0 && h('div', { class: 'status-list' }, rows),
    h('div', { class: 'controls' },
      (snap.cameras || []).length > 0 && h('div', { class: 'cams' },
        snap.cameras.map((c) => h('button', {
          type: 'button',
          class: 'scene cam-btn',
          onclick: () => openCamera(c, null),
        }, svgIcon(CAMERA_ICON, { size: 20 }), c.name))),
      snap.scenes.length > 0 && h('div', { class: 'scenes' },
        snap.scenes.map((s) => {
          const cls = ['scene'];
          if (s.entity === (state.pendingScene || snap.currentScene)) cls.push('is-current');
          if (s.entity === state.pendingScene) cls.push('is-pending');
          if (s.entity === state.sceneError) cls.push('is-error');
          return h('button', { type: 'button', class: cls.join(' '), onclick: () => activateScene(s.entity) }, s.name);
        }))),
  );
}

/** "Done in 23 min", "Done in 1 hr 5 min", "Finishing", or "Running" when no time is known. */
function applianceText(a, now) {
  if (!a.finishesAt) return 'Running';
  const mins = Math.ceil((new Date(a.finishesAt) - now) / 60e3);
  if (mins <= 0) return 'Finishing';
  if (mins < 60) return `Done in ${mins} min`;
  const rem = mins % 60;
  return `Done in ${Math.floor(mins / 60)} hr${rem ? ` ${rem} min` : ''}`;
}

function statusRow(name, value, tone) {
  return h('div', { class: 'status-row' },
    h('span', { class: 'k' }, name),
    h('span', { class: tone }, value));
}

// ---------- Camera view ----------

/** A trigger (doorbell, person, motion) on a camera pops its view open and wakes the screen. */
function checkCameraAlerts(snap) {
  for (const c of snap.cameras || []) {
    if (!c.alert) continue;
    const key = `${c.entity}@${c.alert.at}`;
    if (state.seenAlerts.has(key)) continue;
    state.seenAlerts.add(key);
    if (state.display) state.display.wake();
    openCamera(c, c.alert);
  }
}

function openCamera(cam, alert) {
  closeCamera();
  const el = $('camera');
  const img = $('cam-img');
  $('cam-title').textContent = cam.name;
  $('cam-sub').textContent = alert ? `${alert.by} · ${fmtTime(new Date(alert.at), state.snap.settings.clock24h)}` : 'Live view';
  img.alt = `${cam.name} camera`;
  el.hidden = false;

  const width = Math.min(1920, Math.round(window.innerWidth * (window.devicePixelRatio || 1)));
  const cur = { entity: cam.entity, refreshTimer: null, closeTimer: null };
  state.camera = cur;

  // Load each frame off-screen and swap it in, so the view never flashes blank.
  const load = () => {
    const next = new Image();
    next.onload = () => {
      if (state.camera !== cur) return;
      img.src = next.src;
      cur.refreshTimer = setTimeout(load, CAMERA_REFRESH_MS);
    };
    next.onerror = () => {
      if (state.camera !== cur) return;
      $('cam-sub').textContent = 'Camera unavailable — retrying';
      cur.refreshTimer = setTimeout(load, CAMERA_REFRESH_MS * 3);
    };
    next.src = `api/cameras/${encodeURIComponent(cam.entity)}/snapshot?w=${width}&t=${Date.now()}`;
  };
  load();
  cur.closeTimer = setTimeout(closeCamera, alert ? cam.popupSeconds * 1000 : CAMERA_MANUAL_CLOSE_MS);
}

function closeCamera() {
  const cur = state.camera;
  if (!cur) return;
  clearTimeout(cur.refreshTimer);
  clearTimeout(cur.closeTimer);
  state.camera = null;
  $('camera').hidden = true;
  $('cam-img').removeAttribute('src');
}

$('cam-close').addEventListener('click', closeCamera);
$('cam-img').addEventListener('click', closeCamera);

async function activateScene(entity) {
  state.pendingScene = entity;
  state.sceneError = null;
  render();
  try {
    const res = await fetch(`api/scenes/${encodeURIComponent(entity)}`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.snap.currentScene = entity;
  } catch (err) {
    console.warn('Scene failed', err);
    state.sceneError = entity;
    setTimeout(() => {
      if (state.sceneError === entity) {
        state.sceneError = null;
        render();
      }
    }, 4000);
  }
  state.pendingScene = null;
  render();
}

function renderChips({ snap }) {
  replace($('chips'), snap.calendars.map((c) => {
    const on = !state.hidden.has(c.id);
    return h('button', {
      type: 'button',
      class: 'chip',
      'aria-pressed': on ? 'true' : 'false',
      style: { '--c': c.color },
      title: c.error ? 'Calendar could not be refreshed' : null,
      onclick: () => {
        if (on) state.hidden.add(c.id);
        else state.hidden.delete(c.id);
        saveHidden();
        render();
      },
    }, h('span', { class: 'dot' }), h('span', null, c.error ? `${c.name} ⚠` : c.name));
  }));
}

function selectedEvent({ visible, now }) {
  return visible.find((e) => e.id === state.selectedId && eventEnd(e) > now) || nextEvent(visible, now);
}

function renderAgenda(ctx) {
  const { snap, now, h24, cals, visible } = ctx;
  const days = snap.settings.agendaDays;
  $('agenda-range').textContent = fmtRange(startOfDay(now), addDays(startOfDay(now), days - 1));

  const sel = selectedEvent(ctx);
  const groups = groupByDay(visible, now, days);
  const el = $('agenda');
  const scroll = el.scrollTop;

  if (!groups.length) {
    replace(el, h('div', { class: 'agenda-empty' },
      snap.events.length ? 'Nothing on the selected calendars this week.' : 'Nothing on the calendar this week.'));
    return;
  }

  replace(el, groups.map((g) => h('div', { class: 'day-group' },
    h('div', { class: 'day-label' },
      h('span', { class: g.isToday ? 'name today' : 'name' }, g.name),
      h('span', { class: 'sub' }, g.sub)),
    g.events.map((ev) => {
      const cal = cals.get(ev.cal);
      const rel = g.isToday ? relLabel(ev, now) : '';
      const cls = ['ev'];
      if (sel && ev.id === sel.id) cls.push('is-selected');
      if (ev.busy) cls.push('is-busy');
      if (rel === 'Now') cls.push('is-now');
      return h('button', {
        type: 'button',
        class: cls.join(' '),
        style: { '--c': cal.color },
        'aria-label': `${ev.title}, ${cal.name}, ${whenLabel(ev, now, h24)}`,
        onclick: () => {
          state.selectedId = ev.id;
          render();
        },
      },
      h('span', { class: 'time' }, agendaTime(ev, g.date, h24)),
      h('span', { class: 'dot' }),
      h('span', { class: 'main' },
        h('span', { class: 'title' }, ev.title),
        h('span', { class: 'where' }, ev.location || cal.name)),
      h('span', { class: 'rel' }, rel));
    }))));
  el.scrollTop = scroll;
}

function renderDetail(ctx) {
  const { now, h24, cals } = ctx;
  const el = $('detail');
  const ev = selectedEvent(ctx);
  if (!ev) {
    el.style.removeProperty('--c');
    el.style.removeProperty('--c-soft');
    replace(el, h('div', { class: 'detail-empty' }, 'Nothing coming up.'));
    return;
  }
  const cal = cals.get(ev.cal);
  el.style.setProperty('--c', cal.color);
  el.style.setProperty('--c-soft', tint(cal.color, 0.16));
  const notes = ev.busy
    ? 'This calendar is shared as free/busy only, so the dashboard shows the time block without details.'
    : ev.description;
  replace(el,
    h('div', { class: 'detail-cal' }, h('span', { class: 'dot' }), h('span', null, cal.name)),
    h('h2', { class: 'detail-title' }, ev.title),
    h('div', { class: 'detail-when' },
      h('span', null, whenLabel(ev, now, h24)),
      ev.location && h('span', { class: 'where' }, ev.location)),
    notes && h('div', { class: 'detail-section' },
      h('span', { class: 'eyebrow' }, 'Notes'),
      h('span', { class: 'detail-notes' }, notes)),
  );
}

/** "#FF9A5C" → "rgba(255, 154, 92, 0.16)". Done in JS because color-mix() is too new for older WebViews. */
function tint(hex, alpha) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return 'transparent';
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}

function headsUpItems({ snap, now }) {
  const ids = new Set(snap.calendars.filter((c) => c.headsUp).map((c) => c.id));
  const until = addDays(startOfDay(now), 4);
  return snap.events
    .filter((e) => ids.has(e.cal) && eventEnd(e) > now && eventStart(e) < until)
    .slice(0, 4);
}

function renderHeadsUp(ctx) {
  const items = headsUpItems(ctx);
  const el = $('headsup');
  el.hidden = !items.length;
  if (!items.length) return;
  replace(el,
    h('h2', { class: 'h-card' }, 'Heads up'),
    items.map((e) => h('div', { class: 'row' },
      h('span', null, e.title),
      h('span', { class: 'when' }, headsUpWhen(e, ctx.now)))));
}

function renderNight(ctx) {
  const { snap, now, h24, visible } = ctx;
  const p = clockParts(now, h24);
  $('night-time').textContent = p.time;
  $('night-ampm').textContent = p.ampm;
  $('night-date').textContent = fmtDateLong(now);
  const w = snap.weather;
  $('night-weather').textContent = w ? `${w.temperature}° · ${w.label}` : '';

  const next = nextEvent(visible.filter((e) => !e.allDay && eventStart(e) > now), now);
  const nextCol = h('div', null,
    h('span', { class: 'eyebrow' }, 'Next up'),
    next ? [h('span', { class: 'hl' }, next.title), h('span', null, `${dayName(eventStart(next), now)} · ${fmtTime(eventStart(next), h24)}`)]
      : h('span', null, 'Nothing scheduled'));

  const hu = headsUpItems(ctx)[0];
  const midCol = h('div', null,
    h('span', { class: 'eyebrow' }, 'Heads up'),
    hu ? [h('span', { class: 'warn' }, hu.title), h('span', null, headsUpWhen(hu, now))]
      : w && w.headsUp ? h('span', { class: 'warn' }, weatherHeadsUpText(w.headsUp, h24))
        : h('span', null, 'Nothing tonight'));

  const ex = snap.house;
  const houseCol = h('div', null,
    h('span', { class: 'eyebrow' }, 'House'),
    ex.length
      ? [h('span', { class: 'warn' }, `${ex[0].name} ${ex[0].label.toLowerCase()}`),
        h('span', null, ex.length > 1 ? `+${ex.length - 1} more · tap to see` : 'Tap to see')]
      : h('span', { class: 'hl' }, snap.houseTotal ? 'All secure' : ''),
    (snap.appliances || []).map((a) => h('span', null, `${a.name} · ${applianceText(a, now).toLowerCase()}`)),
    snap.lights.total > 0 && h('span', null, snap.lights.on ? `${snap.lights.on} lights on` : 'Lights off'));

  replace($('night-info'), nextCol, midCol, houseCol);
}

function renderStatus() {
  const el = $('status');
  const snap = state.snap;
  let text = '';
  if (state.streamDownSince && Date.now() - state.streamDownSince > OFFLINE_AFTER_MS) {
    const at = snap && snap.generatedAt ? ` · updated ${fmtTime(new Date(snap.generatedAt), snap.settings.clock24h)}` : '';
    text = `Reconnecting${at}`;
  } else if (snap && !snap.mock && !snap.connected) {
    text = 'Live updates off';
  } else if (snap && snap.mock) {
    text = 'Demo data';
  }
  el.hidden = !text;
  el.textContent = text;
}

setInterval(renderStatus, 10e3);
start();
