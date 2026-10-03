// Screen behaviour: day/night mode, idle reset, brightness, wake on motion,
// and pixel shift. Talks to Fully Kiosk's injected `window.fully` object;
// when that's missing (desktop browser) a stub stands in so the same logic
// runs unchanged.
//
// URL switches for testing:
//   ?mode=night | ?mode=day   force a view
//   ?sim=1                    stub dims the page to mimic brightness changes
//   press "m"                 simulate a motion event

const TICK_MS = 15e3;
const SHIFT_STEPS = [[0, 0], [3, 2], [-2, 3], [-3, -2], [2, -3], [4, 0], [0, 4], [-4, 0], [0, -4]];

export function minutesOfDay(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
}

/** True when `date` falls in [start, end), handling windows that cross midnight. */
export function inWindow(date, start, end) {
  const t = date.getHours() * 60 + date.getMinutes();
  const s = minutesOfDay(start);
  const e = minutesOfDay(end);
  return s <= e ? t >= s && t < e : t >= s || t < e;
}

export function createDisplay({ getSettings, onMode, onIdle, now = () => new Date() }) {
  const params = new URLSearchParams(location.search);
  const forced = params.get('mode');
  const fully = window.fully || installStub(params.get('sim') === '1');

  let lastActivity = Date.now();
  let mode = null;
  let idleFired = false;
  let screenOff = false;
  let brightness = null;

  function settings() {
    return getSettings().display;
  }

  function activity() {
    lastActivity = Date.now();
    idleFired = false;
    if (screenOff) {
      screenOff = false;
      call('turnScreenOn');
    }
    update();
  }

  function update() {
    const s = settings();
    const t = now();
    const idleMs = Date.now() - lastActivity;
    const night = inWindow(t, s.nightStart, s.nightEnd);

    let next = night && idleMs > s.wakeMinutes * 60e3 ? 'night' : 'day';
    if (forced === 'night' || forced === 'day') next = forced;

    if (next !== mode) {
      mode = next;
      onMode(mode);
    }
    setBrightness(mode === 'night' ? s.brightnessNight : s.brightnessDay);

    if (mode === 'day' && !idleFired && idleMs > s.idleMinutes * 60e3) {
      idleFired = true;
      onIdle();
    }
    if (mode === 'night' && s.screenOffAfterMinutes && !screenOff && idleMs > s.screenOffAfterMinutes * 60e3) {
      screenOff = true;
      call('turnScreenOff', true);
    }
    shift(s.pixelShift, t);
  }

  function setBrightness(value) {
    if (value == null || value === brightness) return;
    brightness = value;
    call('setScreenBrightness', Math.max(0, Math.min(255, Math.round(value))));
  }

  function call(name, ...args) {
    try {
      if (typeof fully[name] === 'function') fully[name](...args);
    } catch (err) {
      console.warn(`fully.${name} failed`, err);
    }
  }

  const shiftEl = document.getElementById('shift');
  let shiftIndex = -1;
  function shift(enabled, t) {
    const i = enabled ? Math.floor(t.getTime() / 3600e3) % SHIFT_STEPS.length : 0;
    if (i === shiftIndex) return;
    shiftIndex = i;
    const [x, y] = SHIFT_STEPS[i];
    shiftEl.style.transform = x || y ? `translate(${x}px, ${y}px)` : '';
  }

  // Touch anywhere counts as activity. Mouse movement too, which is how a
  // desktop browser "wakes" the night view during testing.
  for (const type of ['pointerdown', 'keydown', 'wheel']) {
    window.addEventListener(type, activity, { passive: true, capture: true });
  }
  let lastMove = 0;
  window.addEventListener('mousemove', () => {
    if (Date.now() - lastMove > 1000) {
      lastMove = Date.now();
      activity();
    }
  }, { passive: true });

  // Fully Kiosk calls back by evaluating a JS string.
  window.dashboardMotion = activity;
  call('bind', 'onMotion', 'window.dashboardMotion && window.dashboardMotion()');
  call('bind', 'screenOn', 'window.dashboardMotion && window.dashboardMotion()');

  update();
  setInterval(update, TICK_MS);

  return {
    get mode() { return mode; },
    wake: activity,
    refresh: update,
  };
}

/** Desktop stand-in for Fully Kiosk's JS interface. */
function installStub(simulate) {
  const handlers = {};
  const stub = {
    isStub: true,
    bind(event, code) { handlers[event] = code; },
    setScreenBrightness(v) {
      console.debug('[fully stub] brightness', v);
      if (simulate) document.documentElement.style.filter = `brightness(${Math.max(0.2, v / 255).toFixed(2)})`;
    },
    turnScreenOn() {
      console.debug('[fully stub] screen on');
      if (simulate) document.documentElement.style.opacity = '';
    },
    turnScreenOff() {
      console.debug('[fully stub] screen off');
      if (simulate) document.documentElement.style.opacity = '0';
    },
  };
  window.addEventListener('keydown', (e) => {
    if (e.key === 'm' && handlers.onMotion) {
      console.debug('[fully stub] motion');
      // Same path Fully uses: evaluate the bound code string.
      new Function(handlers.onMotion)();
    }
  });
  window.fully = stub;
  return stub;
}
