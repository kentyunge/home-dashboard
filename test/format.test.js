import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agendaTime, clockParts, groupByDay, nextEvent, relLabel, whenLabel, fmtHour, fmtTimeShort,
} from '../public/js/format.js';
import { inWindow } from '../public/js/display.js';

// Dates are built in local time so these pass in any TZ.
const at = (d, h, m = 0) => new Date(2026, 9, d, h, m);
const timed = (id, d1, h1, d2, h2, extra) => ({ id, start: at(d1, h1).toISOString(), end: at(d2, h2).toISOString(), allDay: false, title: id, ...extra });
const allDay = (id, start, end) => ({ id, start, end, allDay: true, title: id });

const now = at(3, 9, 31); // Sat Oct 3 2026, 9:31

test('clockParts 12h and 24h', () => {
  assert.deepEqual(clockParts(at(3, 9, 5), false), { time: '9:05', ampm: 'AM' });
  assert.deepEqual(clockParts(at(3, 0, 0), false), { time: '12:00', ampm: 'AM' });
  assert.deepEqual(clockParts(at(3, 21, 31), true), { time: '21:31', ampm: '' });
});

test('fmtHour / fmtTimeShort', () => {
  assert.equal(fmtHour(at(3, 12)), '12p');
  assert.equal(fmtHour(at(3, 10)), '10a');
  assert.equal(fmtTimeShort(at(3, 20)), '8 PM');
  assert.equal(fmtTimeShort(at(3, 20, 30)), '8:30 PM');
});

test('groupByDay drops ended events, omits empty days, spans multi-day', () => {
  const events = [
    timed('done', 3, 7, 3, 8),
    timed('soccer', 3, 10, 3, 11),
    timed('ongoing', 3, 9, 3, 10),
    allDay('bins', '2026-10-04', '2026-10-05'),
    allDay('trip', '2026-10-05', '2026-10-08'), // Mon–Wed
    timed('late', 12, 9, 12, 10), // beyond the window
  ];
  const groups = groupByDay(events, now, 7);
  assert.deepEqual(groups.map((g) => [g.name, g.events.map((e) => e.id)]), [
    ['Today', ['ongoing', 'soccer']],
    ['Tomorrow', ['bins']],
    [groups[2].name, ['trip']],
    [groups[3].name, ['trip']],
    [groups[4].name, ['trip']],
  ]);
  assert.equal(groups[0].isToday, true);
});

test('groupByDay keeps all-day events for today', () => {
  const groups = groupByDay([allDay('today', '2026-10-03', '2026-10-04')], at(3, 23, 59), 3);
  assert.equal(groups.length, 1);
});

test('relLabel', () => {
  assert.equal(relLabel(timed('a', 3, 10, 3, 11), now), 'in 29 min');
  assert.equal(relLabel(timed('b', 3, 9, 3, 10), now), 'Now');
  assert.equal(relLabel(timed('c', 3, 11, 3, 12), now), 'in 1 hr 29 min');
  assert.equal(relLabel(timed('d', 3, 18, 3, 19), now), '');
});

test('whenLabel', () => {
  assert.equal(whenLabel(timed('a', 3, 10, 3, 11, {}), now, false).replace(/:\d\d/g, ''), 'Today · 10 – 11 AM');
  assert.equal(whenLabel(timed('b', 4, 11, 4, 13), now, false), 'Tomorrow · 11:00 AM – 1:00 PM');
  assert.equal(whenLabel(allDay('c', '2026-10-04', '2026-10-05'), now), 'Tomorrow · all day');
  assert.match(whenLabel(allDay('d', '2026-10-03', '2026-10-05'), now), /^Today – Tomorrow · all day$/);
});

test('agendaTime for an event that started the day before', () => {
  const ev = timed('overnight', 2, 22, 3, 15);
  assert.equal(agendaTime(ev, at(3, 0), false), 'Until 3 PM');
  assert.equal(agendaTime(allDay('x', '2026-10-03', '2026-10-04'), at(3, 0), false), 'All day');
});

test('nextEvent prefers the current or next timed event', () => {
  const events = [allDay('bins', '2026-10-03', '2026-10-04'), timed('later', 3, 18, 3, 19), timed('soon', 3, 10, 3, 11)];
  assert.equal(nextEvent(events, now).id, 'soon');
  assert.equal(nextEvent([allDay('bins', '2026-10-03', '2026-10-04')], now).id, 'bins');
  assert.equal(nextEvent([], now), null);
});

test('inWindow handles windows across midnight', () => {
  assert.equal(inWindow(at(3, 23), '22:00', '06:30'), true);
  assert.equal(inWindow(at(3, 6, 15), '22:00', '06:30'), true);
  assert.equal(inWindow(at(3, 6, 30), '22:00', '06:30'), false);
  assert.equal(inWindow(at(3, 12), '22:00', '06:30'), false);
  assert.equal(inWindow(at(3, 13), '12:00', '14:00'), true);
});
