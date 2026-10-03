import { createHash } from 'node:crypto';

/**
 * Convert an event from HA's calendar API into the dashboard's shape.
 *
 * HA returns { start: { dateTime } | { date }, end: ..., summary, description,
 * location, uid, recurrence_id }. All-day events keep their YYYY-MM-DD dates
 * (end is exclusive) so the tablet places them on its own local day.
 *
 * Calendars marked busyOnly are stripped here, on the server, so titles and
 * notes from a work calendar never reach the tablet.
 */
export function normalizeEvent(raw, cal) {
  const allDay = !!(raw.start && raw.start.date && !raw.start.dateTime);
  const start = allDay ? raw.start.date : toIso(raw.start && raw.start.dateTime);
  const end = allDay ? raw.end && raw.end.date : toIso(raw.end && raw.end.dateTime);
  if (!start) return null;

  const busy = cal.busyOnly;
  const key = [cal.entity, raw.uid || '', raw.recurrence_id || '', start, busy ? '' : raw.summary || ''].join('|');
  return {
    id: createHash('sha1').update(key).digest('hex').slice(0, 12),
    cal: cal.entity,
    title: busy ? 'Busy' : (raw.summary || '(No title)').trim(),
    start,
    end: end || start,
    allDay,
    location: busy ? '' : cleanText(raw.location),
    description: busy ? '' : cleanText(raw.description),
    busy,
  };
}

function toIso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Calendar descriptions (esp. Google) often contain HTML. The tablet only shows text. */
export function cleanText(value) {
  if (!value) return '';
  return String(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 2000);
}

/** Sort key that puts all-day events first within a day, then by start time. */
export function sortEvents(events) {
  return events.slice().sort((a, b) => {
    const as = a.allDay ? a.start + 'T00:00:00' : a.start;
    const bs = b.allDay ? b.start + 'T00:00:00' : b.start;
    if (as !== bs) return as < bs ? -1 : 1;
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}
