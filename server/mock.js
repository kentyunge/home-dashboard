/**
 * Stand-in for Home Assistant so the dashboard runs with no HA at all
 * (MOCK=1, or HA_URL unset). Data is generated relative to "now" so the
 * agenda always has something upcoming. Implements the same interface
 * as HomeAssistant in ha.js.
 */

// Per configured calendar (by position): [dayOffset, "HH:MM" | "+minutesFromNow" | null (all day), minutes, title, location, notes]
const TEMPLATES = [
  [
    [0, '+480', 150, 'Dinner with the neighbors', '', "We're bringing a salad."],
    [1, '11:00', 30, 'Grocery pickup', 'Market Street Grocery', 'Order locks Saturday at 9 PM.'],
    [4, '19:00', 120, 'Movie night', '', 'Kids pick the movie this week.'],
  ],
  [
    [2, '14:00', 60, '1:1 with manager', 'Conference room', 'Quarterly goals'],
    [3, '09:00', 90, 'Planning', '', ''],
  ],
  [
    [0, '+45', 75, 'Soccer — U10 game', 'Riverside Park · Field 4', 'Our week for halftime snacks. Orange jerseys.'],
    [3, '18:00', 45, 'Piano lesson', 'Maple Street studio', 'Bring the theory workbook.'],
    [4, '17:30', 60, 'Soccer practice', 'Riverside Park', 'Cleats and water bottle.'],
  ],
  [
    [2, '08:15', 30, 'Picture day', 'Lincoln Elementary', 'Order form is in the backpack folder.'],
    [3, '19:00', 90, 'PTO meeting', 'School library', 'Fall fundraiser planning.'],
  ],
  [
    [0, '+210', 240, 'Fall scramble', 'Oak Hills Golf Club', 'Shotgun start. Cart assignments posted at the clubhouse.'],
    [5, '18:00', 120, 'Season wrap-up dinner', 'Clubhouse', 'Final standings and awards.'],
  ],
  [
    [1, null, 0, 'Bins to the curb tonight', '', 'Pickup is Monday morning. Recycling this week.'],
    [6, null, 0, 'Change furnace filter', '', '20x25x1, spares are in the garage.'],
  ],
];

export class MockHomeAssistant {
  constructor(config, { now = () => new Date() } = {}) {
    this.config = config;
    this.now = now;
    this.listeners = null;
    this.states = new Map();
    this.seedStates();
  }

  seedStates() {
    const now = this.now();
    const set = (entity_id, state, attributes = {}) =>
      this.states.set(entity_id, { entity_id, state, attributes, last_changed: now.toISOString() });

    if (this.config.weather) {
      set(this.config.weather.entity, 'partlycloudy', { temperature: 54, temperature_unit: '°F', friendly_name: 'Home' });
    }
    const lightNames = ['kitchen', 'living_room', 'dining', 'hallway', 'porch', 'office', 'bedroom', 'kids_room', 'garage'];
    const lights = this.config.lights || lightNames.map((n) => `light.${n}`);
    lights.forEach((id, i) => set(id, i < 3 ? 'on' : 'off'));

    this.config.scenes.forEach((s, i) => {
      const at = new Date(now.getTime() - (i + 1) * 3600e3 * (i === 1 ? 0.5 : 5));
      set(s.entity, at.toISOString());
    });

    this.config.house.forEach((h, i) => {
      // Second item is off-normal so the exceptions list has something to show.
      const normal = h.normal[0] || 'off';
      const abnormal = { locked: 'unlocked', closed: 'open', off: 'on' }[normal] || 'on';
      set(h.entity, i === 1 ? abnormal : normal);
    });

    for (const a of this.config.appliances) {
      if (a.state) set(a.state, 'run');
      if (a.remaining) set(a.remaining, '23', { unit_of_measurement: 'min', device_class: 'duration' });
    }
    for (const t of this.config.tasks) if (!this.states.has(t.entity)) set(t.entity, 'off');
    if (this.config.climate) {
      set(this.config.climate.entity, 'heat', { current_temperature: 68, temperature: 70, hvac_action: 'heating' });
    }
    this.config.calendars.forEach((c) => set(c.entity, 'off'));
  }

  async getStates() {
    return [...this.states.values()];
  }

  async getCalendarEvents(entity, start, end) {
    const idx = this.config.calendars.findIndex((c) => c.entity === entity);
    const templates = TEMPLATES[idx % TEMPLATES.length] || [];
    const now = this.now();
    const out = [];
    for (const [dayOffset, time, minutes, summary, location, description] of templates) {
      const day = new Date(now);
      day.setHours(0, 0, 0, 0);
      day.setDate(day.getDate() + dayOffset);
      let ev;
      if (time === null) {
        const next = new Date(day);
        next.setDate(next.getDate() + 1);
        ev = { start: { date: ymd(day) }, end: { date: ymd(next) } };
      } else {
        let s;
        if (time.startsWith('+')) {
          s = new Date(now.getTime() + Number(time.slice(1)) * 60e3);
          s.setMinutes(Math.round(s.getMinutes() / 15) * 15, 0, 0);
        } else {
          const [h, m] = time.split(':').map(Number);
          s = new Date(day);
          s.setHours(h, m, 0, 0);
        }
        const e = new Date(s.getTime() + minutes * 60e3);
        ev = { start: { dateTime: s.toISOString() }, end: { dateTime: e.toISOString() } };
      }
      const evStart = new Date(ev.start.dateTime || ev.start.date + 'T00:00:00');
      if (evStart < start || evStart >= end) continue;
      out.push({ ...ev, summary, location, description, uid: `${entity}-${dayOffset}-${summary}` });
    }
    return out;
  }

  async getForecast(entity, type) {
    const now = this.now();
    if (type === 'daily') {
      return Array.from({ length: 5 }, (_, i) => {
        const d = new Date(now);
        d.setHours(12, 0, 0, 0);
        d.setDate(d.getDate() + i);
        return { datetime: d.toISOString(), condition: i === 0 ? 'partlycloudy' : 'rainy', temperature: 61 - i, templow: 43 - i };
      });
    }
    const base = new Date(now);
    base.setMinutes(0, 0, 0);
    return Array.from({ length: 24 }, (_, i) => {
      const t = new Date(base.getTime() + (i + 1) * 3600e3);
      const h = t.getHours();
      const temp = 50 + 10 * Math.sin(((h - 9) / 24) * 2 * Math.PI);
      const rainy = i >= 9 && i <= 14;
      return {
        datetime: t.toISOString(),
        condition: rainy ? 'rainy' : h >= 19 || h < 6 ? 'clear-night' : 'partlycloudy',
        temperature: Math.round(temp),
        precipitation_probability: rainy ? 70 : 10,
      };
    });
  }

  async cameraSnapshot(entity) {
    const cam = this.config.cameras.find((c) => c.entity === entity);
    const t = this.now().toLocaleTimeString();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">`
      + `<rect width="1280" height="720" fill="#1E252E"/><rect x="0" y="480" width="1280" height="240" fill="#2A323D"/>`
      + `<text x="40" y="70" fill="#E7EAEE" font-family="sans-serif" font-size="40">${cam ? cam.name : entity} (demo)</text>`
      + `<text x="40" y="680" fill="#9AA4B1" font-family="sans-serif" font-size="32">${t}</text></svg>`;
    return { type: 'image/svg+xml', body: Buffer.from(svg) };
  }

  async turnOnScene(entity) {
    const now = this.now().toISOString();
    this.update(entity, now);
    const idx = this.config.scenes.findIndex((s) => s.entity === entity);
    const lights = this.config.lights || [...this.states.keys()].filter((id) => id.startsWith('light.'));
    const onCount = idx === 0 ? 0 : Math.min(lights.length, 2 + idx * 2);
    lights.forEach((id, i) => this.update(id, i < onCount ? 'on' : 'off'));
  }

  update(entity_id, state) {
    const prev = this.states.get(entity_id) || { entity_id, attributes: {} };
    const next = { ...prev, state, last_changed: this.now().toISOString() };
    this.states.set(entity_id, next);
    if (this.listeners) this.listeners.onState(entity_id, next);
  }

  connect(listeners) {
    this.listeners = listeners;
    setTimeout(() => listeners.onStatus(true), 0);
  }

  close() {}
}

function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
