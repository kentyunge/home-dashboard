import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DISPLAY_DEFAULTS = {
  nightStart: '22:00',
  nightEnd: '06:30',
  wakeMinutes: 2,
  idleMinutes: 5,
  brightnessDay: 180,
  brightnessNight: 8,
  screenOffAfterMinutes: null,
  pixelShift: true,
};

/**
 * Load configuration. Secrets and deployment settings come from env vars;
 * the structured household setup (calendars, scenes, house sensors) comes
 * from a JSON file so it can be edited without rebuilding the image.
 */
export function loadConfig(env = process.env) {
  const configPath = env.CONFIG_PATH
    ? resolve(env.CONFIG_PATH)
    : resolve(root, 'config/dashboard.json');
  const fallbackPath = resolve(root, 'config/dashboard.example.json');

  let file = {};
  let source = null;
  if (existsSync(configPath)) {
    source = configPath;
  } else if (!env.HA_URL) {
    // Mock mode with no config: use the example so the UI has something to show.
    source = fallbackPath;
  }
  if (source) {
    file = JSON.parse(readFileSync(source, 'utf8'));
  } else {
    throw new Error(`Config file not found: ${configPath} (set CONFIG_PATH or copy config/dashboard.example.json)`);
  }

  const mock = env.MOCK === '1' || env.MOCK === 'true' || !env.HA_URL;
  if (!mock && !env.HA_TOKEN) {
    throw new Error('HA_TOKEN is required when HA_URL is set');
  }

  const config = {
    port: Number(env.PORT || 8080),
    host: env.HOST || '0.0.0.0',
    haUrl: (env.HA_URL || '').replace(/\/+$/, ''),
    haToken: env.HA_TOKEN || '',
    mock,
    accessKey: env.ACCESS_KEY || '',
    tlsCert: env.TLS_CERT || '',
    tlsKey: env.TLS_KEY || '',
    configSource: source,

    agendaDays: clampInt(file.agendaDays, 1, 14, 7),
    clock24h: !!file.clock24h,
    calendars: (file.calendars || []).map((c) => ({
      entity: required(c.entity, 'calendars[].entity'),
      name: c.name || c.entity,
      color: c.color || '#A3ADBA',
      busyOnly: !!c.busyOnly,
      headsUp: !!c.headsUp,
    })),
    weather: file.weather && file.weather.entity ? { entity: file.weather.entity } : null,
    scenes: (file.scenes || []).map((s) => ({
      entity: required(s.entity, 'scenes[].entity'),
      name: s.name || s.entity,
    })),
    lights: Array.isArray(file.lights) ? file.lights : null,
    house: (file.house || []).map((h) => ({
      entity: required(h.entity, 'house[].entity'),
      name: h.name || h.entity,
      normal: [].concat(h.normal ?? []),
      labels: h.labels || {},
    })),
    appliances: (file.appliances || []).map((a) => ({
      name: required(a.name, 'appliances[].name'),
      state: a.state || null,
      runningStates: a.runningStates ? [].concat(a.runningStates) : null,
      remaining: a.remaining || null,
    })),
    cameras: (file.cameras || []).map((c) => ({
      entity: required(c.entity, 'cameras[].entity'),
      name: c.name || c.entity,
      triggers: [].concat(c.triggers || []),
      popupSeconds: clampInt(c.popupSeconds, 10, 600, 60),
    })),
    climate: file.climate && file.climate.entity
      ? { entity: file.climate.entity, name: file.climate.name || 'Thermostat' }
      : null,
    display: { ...DISPLAY_DEFAULTS, ...(file.display || {}) },
  };

  for (const c of config.cameras) {
    if (!c.entity.startsWith('camera.')) {
      throw new Error(`Camera entity must be a camera.*: ${c.entity}`);
    }
  }
  for (const s of config.scenes) {
    if (!s.entity.startsWith('scene.')) {
      throw new Error(`Scene entity must be a scene.*: ${s.entity}`);
    }
  }
  return config;
}

function required(value, name) {
  if (!value) throw new Error(`Config: ${name} is required`);
  return value;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
