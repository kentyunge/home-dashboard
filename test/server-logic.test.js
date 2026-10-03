import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent, cleanText, sortEvents } from '../server/calendar.js';
import { headsUp, buildWeather } from '../server/weather.js';
import { houseExceptions, lightCount, sceneList, climateSummary, applianceStatus, finishTime } from '../server/house.js';

const cal = { entity: 'calendar.family', name: 'Family', color: '#7FB2FF', busyOnly: false };

test('normalizeEvent: timed event', () => {
  const ev = normalizeEvent({
    start: { dateTime: '2026-10-03T10:30:00-05:00' },
    end: { dateTime: '2026-10-03T11:45:00-05:00' },
    summary: ' Soccer ', location: 'Field 4', description: 'Snacks', uid: 'abc',
  }, cal);
  assert.equal(ev.title, 'Soccer');
  assert.equal(ev.start, '2026-10-03T15:30:00.000Z');
  assert.equal(ev.allDay, false);
  assert.equal(ev.cal, 'calendar.family');
  assert.match(ev.id, /^[0-9a-f]{12}$/);
});

test('normalizeEvent: all-day keeps dates', () => {
  const ev = normalizeEvent({ start: { date: '2026-10-04' }, end: { date: '2026-10-05' }, summary: 'Bins' }, cal);
  assert.equal(ev.allDay, true);
  assert.equal(ev.start, '2026-10-04');
  assert.equal(ev.end, '2026-10-05');
});

test('normalizeEvent: busyOnly strips details server-side', () => {
  const ev = normalizeEvent({
    start: { dateTime: '2026-10-05T14:00:00Z' }, end: { dateTime: '2026-10-05T15:00:00Z' },
    summary: 'Secret project review', location: 'Room 4', description: 'Confidential',
  }, { ...cal, busyOnly: true });
  assert.equal(ev.title, 'Busy');
  assert.equal(ev.location, '');
  assert.equal(ev.description, '');
  assert.equal(ev.busy, true);
  assert.ok(!JSON.stringify(ev).includes('Secret'));
});

test('normalizeEvent: rejects events without a start', () => {
  assert.equal(normalizeEvent({ start: {}, end: {} }, cal), null);
});

test('cleanText strips HTML from descriptions', () => {
  assert.equal(cleanText('Bring <b>cleats</b><br>and water &amp; snacks'), 'Bring cleats\nand water & snacks');
  assert.equal(cleanText(null), '');
});

test('sortEvents puts all-day first then by time', () => {
  const out = sortEvents([
    { title: 'b', start: '2026-10-04T15:00:00.000Z', allDay: false },
    { title: 'a', start: '2026-10-04', allDay: true },
    { title: 'c', start: '2026-10-03T15:00:00.000Z', allDay: false },
  ]);
  assert.deepEqual(out.map((e) => e.title), ['c', 'a', 'b']);
});

const now = new Date('2026-10-03T14:00:00Z');
const hour = (n, extra) => ({ datetime: new Date(now.getTime() + n * 3600e3).toISOString(), temperature: 55, condition: 'cloudy', ...extra });

test('headsUp: rain later today', () => {
  const hu = headsUp([hour(1), hour(2), hour(6, { condition: 'rainy' })], '°F', now);
  assert.equal(hu.kind, 'precip');
  assert.equal(hu.label, 'Rain');
  assert.equal(hu.at, hour(6).datetime);
});

test('headsUp: precipitation probability counts even when condition is cloudy', () => {
  const hu = headsUp([hour(3, { precipitation_probability: 80 })], '°F', now);
  assert.equal(hu.kind, 'precip');
});

test('headsUp: rain now has no time', () => {
  const hu = headsUp([hour(0.25, { condition: 'pouring' })], '°F', now);
  assert.equal(hu.label, 'Heavy rain');
  assert.equal(hu.at, null);
});

test('headsUp: freeze in Celsius', () => {
  const hu = headsUp([hour(1, { temperature: 4 }), hour(8, { temperature: -1 })], '°C', now);
  assert.equal(hu.kind, 'freeze');
  assert.equal(hu.temperature, -1);
});

test('headsUp: nothing beyond 12 hours', () => {
  assert.equal(headsUp([hour(14, { condition: 'snowy' })], '°F', now), null);
});

test('buildWeather: unavailable entity gives null', () => {
  assert.equal(buildWeather({ state: 'unavailable', attributes: {} }, [], [], now), null);
});

test('buildWeather: picks every other hour, five of them', () => {
  const hourly = Array.from({ length: 12 }, (_, i) => hour(i + 1));
  const w = buildWeather({ state: 'sunny', attributes: { temperature: 54.4 } }, hourly, [], now);
  assert.equal(w.temperature, 54);
  assert.equal(w.label, 'Sunny');
  assert.equal(w.hourly.length, 5);
  assert.equal(w.hourly[1].time, hour(3).datetime);
});

const states = new Map(Object.entries({
  'lock.front_door': { state: 'locked' },
  'cover.garage_door': { state: 'open' },
  'binary_sensor.back_door': { state: 'on' },
  'lock.side': { state: 'unavailable' },
  'light.a': { state: 'on', attributes: {} },
  'light.b': { state: 'off', attributes: {} },
  'light.c': { state: 'unavailable', attributes: {} },
  'light.group': { state: 'on', attributes: { entity_id: ['light.a', 'light.b'] } },
  'switch.kitchen': { state: 'on', attributes: {} },
  'scene.evening': { state: '2026-10-03T12:00:00+00:00' },
  'scene.movie': { state: '2026-10-02T12:00:00+00:00' },
  'scene.never': { state: 'unknown' },
  'climate.t': { state: 'heat', attributes: { current_temperature: 67.6, temperature: 70, hvac_action: 'heating' } },
}));

test('houseExceptions lists only off-normal entities', () => {
  const house = [
    { entity: 'lock.front_door', name: 'Front door', normal: ['locked'], labels: {} },
    { entity: 'cover.garage_door', name: 'Garage', normal: ['closed'], labels: {} },
    { entity: 'binary_sensor.back_door', name: 'Back door', normal: ['off'], labels: {} },
    { entity: 'lock.side', name: 'Side door', normal: ['locked'], labels: {} },
    { entity: 'lock.missing', name: 'Missing', normal: ['locked'], labels: {} },
  ];
  assert.deepEqual(houseExceptions(house, states).map((x) => [x.name, x.label]), [
    ['Garage', 'Open'],
    ['Back door', 'Open'],
    ['Side door', 'Offline'],
  ]);
});

test('lightCount skips groups and unavailable lights', () => {
  assert.deepEqual(lightCount(null, states), { on: 1, total: 2 });
  assert.deepEqual(lightCount(['light.b'], states), { on: 0, total: 1 });
});

test('lightCount: switches count only when listed', () => {
  assert.deepEqual(lightCount(['switch.kitchen', 'light.b'], states), { on: 1, total: 2 });
  assert.deepEqual(lightCount(null, states).total, 2);
});

test('sceneList marks the most recently activated scene', () => {
  const s = sceneList([
    { entity: 'scene.movie', name: 'Movie' },
    { entity: 'scene.evening', name: 'Evening' },
    { entity: 'scene.never', name: 'Never' },
  ], states);
  assert.equal(s.current, 'scene.evening');
  assert.equal(s.list[2].lastActivated, null);
});

test('climateSummary rounds temperatures', () => {
  assert.deepEqual(climateSummary({ entity: 'climate.t', name: 'Thermostat' }, states),
    { name: 'Thermostat', mode: 'heat', action: 'heating', current: 68, target: 70 });
});

test('finishTime: timestamp, numeric duration with units, and H:MM[:SS] strings', () => {
  const now = new Date('2026-10-03T14:00:00Z');
  const upd = '2026-10-03T13:55:00Z';
  assert.equal(finishTime({ state: '2026-10-03T14:40:00+00:00', attributes: { device_class: 'timestamp' } }, now).toISOString(), '2026-10-03T14:40:00.000Z');
  // Duration counts from the sensor's last update, not from "now".
  assert.equal(finishTime({ state: '23', attributes: { unit_of_measurement: 'min' }, last_updated: upd }, now).toISOString(), '2026-10-03T14:18:00.000Z');
  assert.equal(finishTime({ state: '0.5', attributes: { unit_of_measurement: 'h' }, last_updated: upd }, now).toISOString(), '2026-10-03T14:25:00.000Z');
  assert.equal(finishTime({ state: '1:05', attributes: {}, last_updated: upd }, now).toISOString(), '2026-10-03T15:00:00.000Z');
  assert.equal(finishTime({ state: '0:10:30', attributes: {}, last_updated: upd }, now).toISOString(), '2026-10-03T14:05:30.000Z');
  assert.equal(finishTime({ state: '0', attributes: {} }, now), null);
  assert.equal(finishTime({ state: 'unavailable', attributes: {} }, now), null);
});

test('applianceStatus: shows only running appliances', () => {
  const now = new Date('2026-10-03T14:00:00Z');
  const st = new Map(Object.entries({
    'sensor.dryer_state': { state: 'run' },
    'sensor.dryer_remaining': { state: '20', attributes: { unit_of_measurement: 'min' }, last_updated: '2026-10-03T14:00:00Z' },
    'sensor.washer_state': { state: 'finished' },
    'sensor.washer_remaining': { state: '0', attributes: {} },
    'sensor.dish_done_at': { state: '2026-10-03T15:00:00+00:00', attributes: { device_class: 'timestamp' } },
    'sensor.oven': { state: 'Baking' },
  }));
  const out = applianceStatus([
    { name: 'Dryer', state: 'sensor.dryer_state', remaining: 'sensor.dryer_remaining' },
    { name: 'Washer', state: 'sensor.washer_state', remaining: 'sensor.washer_remaining' },
    { name: 'Dishwasher', state: null, remaining: 'sensor.dish_done_at' },
    { name: 'Oven', state: 'sensor.oven', runningStates: ['baking'], remaining: null },
  ], st, now);
  assert.deepEqual(out, [
    { name: 'Dryer', finishesAt: '2026-10-03T14:20:00.000Z' },
    { name: 'Dishwasher', finishesAt: '2026-10-03T15:00:00.000Z' },
    { name: 'Oven', finishesAt: null },
  ]);
});
