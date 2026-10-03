import { normalizeEvent, sortEvents } from './calendar.js';
import { buildWeather } from './weather.js';
import { houseExceptions, lightCount, climateSummary, sceneList, applianceStatus } from './house.js';

const CALENDAR_REFRESH_MS = 5 * 60e3;
const FORECAST_REFRESH_MS = 30 * 60e3;
const FORECAST_MIN_GAP_MS = 10 * 60e3;
const EMIT_DEBOUNCE_MS = 400;
const POLL_STATES_MS = 30e3; // only while the WebSocket isn't delivering live updates

/**
 * Keeps the latest HA data in memory and turns it into one snapshot the
 * tablet renders. Live entity states arrive over the WebSocket; calendars
 * and forecasts are polled because HA doesn't push them.
 */
export class Store {
  constructor(config, source, { log = console, now = () => new Date() } = {}) {
    this.config = config;
    this.source = source;
    this.log = log;
    this.now = now;
    this.states = new Map();
    this.events = new Map(); // calendar entity -> normalized events
    this.calendarErrors = new Map();
    this.hourly = [];
    this.daily = [];
    this.forecastAt = 0;
    this.connected = false;
    this.lastUpdate = null;
    this.listeners = new Set();
    this.emitTimer = null;
    this.timers = [];
    this.version = String(Date.now());

    this.watched = new Set([
      ...config.calendars.map((c) => c.entity),
      ...config.scenes.map((s) => s.entity),
      ...config.house.map((h) => h.entity),
      ...(config.weather ? [config.weather.entity] : []),
      ...(config.climate ? [config.climate.entity] : []),
      ...config.appliances.flatMap((a) => [a.state, a.remaining].filter(Boolean)),
      ...(config.lights || []),
    ]);
  }

  isRelevant(id) {
    return this.watched.has(id) || (!this.config.lights && id.startsWith('light.'));
  }

  async start() {
    this.source.connect({
      onState: (id, st) => this.handleState(id, st),
      onStatus: (up) => {
        this.connected = up;
        if (up) this.refreshStates();
        this.scheduleEmit();
      },
    });
    await Promise.all([this.refreshStates(), this.refreshCalendars(), this.refreshForecast()]);
    this.timers.push(setInterval(() => this.refreshCalendars(), CALENDAR_REFRESH_MS));
    this.timers.push(setInterval(() => this.refreshForecast(), FORECAST_REFRESH_MS));
    this.timers.push(setInterval(() => { if (!this.connected) this.refreshStates(); }, POLL_STATES_MS));
    for (const t of this.timers) t.unref?.();
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    clearTimeout(this.emitTimer);
  }

  handleState(id, st) {
    if (!this.isRelevant(id)) return;
    if (st) this.states.set(id, st);
    else this.states.delete(id);
    this.lastUpdate = this.now();

    // A calendar entity flips on/off as events start and end; a good moment to re-read it.
    if (id.startsWith('calendar.')) this.refreshCalendars([id]);
    if (this.config.weather && id === this.config.weather.entity
        && this.now().getTime() - this.forecastAt > FORECAST_MIN_GAP_MS) {
      this.refreshForecast();
    }
    this.scheduleEmit();
  }

  async refreshStates() {
    try {
      const all = await this.source.getStates();
      this.states.clear();
      for (const st of all) {
        if (this.isRelevant(st.entity_id)) this.states.set(st.entity_id, st);
      }
      this.lastUpdate = this.now();
      this.scheduleEmit();
    } catch (err) {
      this.log.error('Failed to load states:', err.message);
    }
  }

  async refreshCalendars(only) {
    const { start, end } = this.agendaRange();
    const cals = this.config.calendars.filter((c) => !only || only.includes(c.entity));
    await Promise.all(cals.map(async (cal) => {
      try {
        const raw = await this.source.getCalendarEvents(cal.entity, start, end);
        this.events.set(cal.entity, raw.map((e) => normalizeEvent(e, cal)).filter(Boolean));
        this.calendarErrors.delete(cal.entity);
      } catch (err) {
        // Keep showing the last good copy rather than blanking the agenda.
        this.calendarErrors.set(cal.entity, err.message);
        this.log.error(`Failed to load ${cal.entity}:`, err.message);
      }
    }));
    this.scheduleEmit();
  }

  async refreshForecast() {
    if (!this.config.weather) return;
    this.forecastAt = this.now().getTime();
    const entity = this.config.weather.entity;
    const [hourly, daily] = await Promise.allSettled([
      this.source.getForecast(entity, 'hourly'),
      this.source.getForecast(entity, 'daily'),
    ]);
    if (hourly.status === 'fulfilled') this.hourly = hourly.value;
    else this.log.error('Hourly forecast failed:', hourly.reason.message);
    if (daily.status === 'fulfilled') this.daily = daily.value;
    else this.log.error('Daily forecast failed:', daily.reason.message);
    this.scheduleEmit();
  }

  /** From local midnight today through the end of the agenda window. */
  agendaRange() {
    const start = this.now();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + this.config.agendaDays);
    return { start, end };
  }

  async activateScene(entity) {
    if (!this.config.scenes.some((s) => s.entity === entity)) {
      const err = new Error('Unknown scene');
      err.status = 404;
      throw err;
    }
    await this.source.turnOnScene(entity);
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  scheduleEmit() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      const snap = this.snapshot();
      for (const fn of this.listeners) fn(snap);
    }, EMIT_DEBOUNCE_MS);
    this.emitTimer.unref?.();
  }

  snapshot() {
    const c = this.config;
    const now = this.now();
    const events = sortEvents([...this.events.values()].flat());
    const scenes = sceneList(c.scenes, this.states);
    return {
      version: this.version,
      generatedAt: now.toISOString(),
      lastUpdate: this.lastUpdate ? this.lastUpdate.toISOString() : null,
      connected: this.connected,
      mock: c.mock,
      settings: { agendaDays: c.agendaDays, clock24h: c.clock24h, display: c.display },
      calendars: c.calendars.map((cal) => ({
        id: cal.entity,
        name: cal.name,
        color: cal.color,
        busyOnly: cal.busyOnly,
        headsUp: cal.headsUp,
        error: this.calendarErrors.has(cal.entity),
      })),
      events,
      weather: c.weather
        ? buildWeather(this.states.get(c.weather.entity), this.hourly, this.daily, now)
        : null,
      scenes: scenes.list,
      currentScene: scenes.current,
      lights: lightCount(c.lights, this.states),
      house: houseExceptions(c.house, this.states),
      houseTotal: c.house.length,
      climate: climateSummary(c.climate, this.states),
      appliances: applianceStatus(c.appliances, this.states, now),
    };
  }
}
