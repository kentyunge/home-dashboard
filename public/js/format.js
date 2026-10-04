// Date/time formatting and agenda grouping. Pure functions, no DOM, so
// they run (and are tested) in Node too. All formatting uses the tablet's
// own locale and time zone.

const LOCALE = undefined; // device default

const DAY_MS = 86400e3;

/** All-day events carry "YYYY-MM-DD"; parse as local midnight, not UTC. */
export function parseLocalDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function eventStart(ev) {
  return ev.allDay ? parseLocalDate(ev.start) : new Date(ev.start);
}

export function eventEnd(ev) {
  return ev.allDay ? parseLocalDate(ev.end) : new Date(ev.end);
}

export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** { time: "9:31", ampm: "AM" } — or 24h { time: "21:31", ampm: "" } */
export function clockParts(date, h24) {
  if (h24) {
    return { time: `${date.getHours()}:${pad(date.getMinutes())}`, ampm: '' };
  }
  const h = date.getHours() % 12 || 12;
  return { time: `${h}:${pad(date.getMinutes())}`, ampm: date.getHours() < 12 ? 'AM' : 'PM' };
}

export function fmtTime(date, h24) {
  const p = clockParts(date, h24);
  return p.ampm ? `${p.time} ${p.ampm}` : p.time;
}

/** Compact hour for the hourly strip: "10a", "12p" (or "14" in 24h). */
export function fmtHour(date, h24) {
  const h = date.getHours();
  if (h24) return String(h);
  return `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`;
}

/** "8 PM" / "8:30 PM" for prose. */
export function fmtTimeShort(date, h24) {
  if (h24 || date.getMinutes()) return fmtTime(date, h24);
  const h = date.getHours();
  return `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
}

export function fmtDateLong(date) {
  return date.toLocaleDateString(LOCALE, { weekday: 'long', month: 'long', day: 'numeric' });
}

export function fmtMonthDay(date) {
  return date.toLocaleDateString(LOCALE, { month: 'short', day: 'numeric' });
}

export function fmtWeekday(date, style = 'long') {
  return date.toLocaleDateString(LOCALE, { weekday: style });
}

/** "Today", "Tomorrow", or the weekday name. */
export function dayName(date, now) {
  const diff = Math.round((startOfDay(date) - startOfDay(now)) / DAY_MS);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return fmtWeekday(date);
}

/** "Oct 3 – 9" or "Sep 29 – Oct 5" */
export function fmtRange(start, end) {
  if (start.getMonth() === end.getMonth()) {
    return `${fmtMonthDay(start)} – ${end.getDate()}`;
  }
  return `${fmtMonthDay(start)} – ${fmtMonthDay(end)}`;
}

/**
 * Group visible events into days from today through `days` days ahead.
 * Events that already ended are dropped; multi-day events appear on each
 * day they cover; days with no events are omitted.
 */
export function groupByDay(events, now, days) {
  const today = startOfDay(now);
  const groups = [];
  for (let i = 0; i < days; i++) {
    const dayStart = addDays(today, i);
    const dayEnd = addDays(today, i + 1);
    const items = events.filter((ev) => {
      const s = eventStart(ev);
      const e = eventEnd(ev);
      const ended = e < now || (e.getTime() === now.getTime() && s < now);
      if (ended) return false;
      // Zero-length events (reminders) still belong to the day they're on.
      return s < dayEnd && (e > dayStart || (e.getTime() === s.getTime() && s >= dayStart));
    });
    if (!items.length) continue;
    items.sort((a, b) => {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return eventStart(a) - eventStart(b);
    });
    groups.push({
      date: dayStart,
      name: dayName(dayStart, now),
      sub: i < 2 ? `${fmtWeekday(dayStart, 'short')}, ${fmtMonthDay(dayStart)}` : fmtMonthDay(dayStart),
      isToday: i === 0,
      events: items,
    });
  }
  return groups;
}

/**
 * Events for the week agenda: calendars the viewer hasn't filtered out,
 * minus heads-up calendars, which only appear in the Heads up card.
 */
export function agendaEvents(events, calendars, hidden) {
  const shown = new Set(calendars.filter((c) => !c.headsUp && !hidden.has(c.id)).map((c) => c.id));
  return events.filter((e) => shown.has(e.cal));
}

/** Start-time column in the agenda: "10:30 AM", "All day", or "Until 3 PM" for something already running. */
export function agendaTime(ev, day, h24) {
  if (ev.allDay) return 'All day';
  const s = eventStart(ev);
  if (s < day) return `Until ${fmtTimeShort(eventEnd(ev), h24)}`;
  return fmtTime(s, h24);
}

/** "Now", "in 45 min", "in 2 hr" for events starting within the next 3 hours. */
export function relLabel(ev, now) {
  if (ev.allDay) return '';
  const s = eventStart(ev);
  const e = eventEnd(ev);
  if (s <= now && e > now) return 'Now';
  const mins = Math.round((s - now) / 60e3);
  if (mins <= 0 || mins > 180) return '';
  if (mins < 60) return `in ${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem >= 15 ? `in ${hrs} hr ${rem} min` : `in ${hrs} hr`;
}

/** "Today · 10:30 – 11:45 AM", "Sunday · all day", "Sat – Mon · all day" */
export function whenLabel(ev, now, h24) {
  const s = eventStart(ev);
  const e = eventEnd(ev);
  if (ev.allDay) {
    const last = addDays(e, -1);
    if (last > s) return `${dayName(s, now)} – ${dayName(last, now)} · all day`;
    return `${dayName(s, now)} · all day`;
  }
  const day = dayName(s, now);
  if (e.getTime() === s.getTime()) return `${day} · ${fmtTime(s, h24)}`;
  if (!sameDay(s, e)) return `${day} ${fmtTime(s, h24)} – ${dayName(e, now)} ${fmtTime(e, h24)}`;
  const sp = clockParts(s, h24);
  const ep = clockParts(e, h24);
  const start = sp.ampm && sp.ampm === ep.ampm ? sp.time : fmtTime(s, h24);
  return `${day} · ${start} – ${fmtTime(e, h24)}`;
}

/** The event to show by default: whatever is on now or next up. */
export function nextEvent(events, now) {
  let best = null;
  for (const ev of events) {
    if (eventEnd(ev) <= now) continue;
    if (ev.allDay) continue;
    if (!best || eventStart(ev) < eventStart(best)) best = ev;
  }
  if (best) return best;
  return events.find((ev) => eventEnd(ev) > now) || null;
}

/** "Sun night", "Tue", "Today" for the heads-up list. */
export function headsUpWhen(ev, now) {
  const s = eventStart(ev);
  const diff = Math.round((startOfDay(s) - startOfDay(now)) / DAY_MS);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return fmtWeekday(s, 'short');
}

function pad(n) {
  return String(n).padStart(2, '0');
}
