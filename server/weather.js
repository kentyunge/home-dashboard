const CONDITION_LABELS = {
  'clear-night': 'Clear',
  cloudy: 'Cloudy',
  exceptional: 'Unusual weather',
  fog: 'Fog',
  hail: 'Hail',
  lightning: 'Thunderstorms',
  'lightning-rainy': 'Thunderstorms',
  partlycloudy: 'Partly cloudy',
  pouring: 'Heavy rain',
  rainy: 'Rain',
  snowy: 'Snow',
  'snowy-rainy': 'Sleet',
  sunny: 'Sunny',
  windy: 'Windy',
  'windy-variant': 'Windy',
};

const WET = {
  rainy: 'Rain',
  pouring: 'Heavy rain',
  'lightning-rainy': 'Storms',
  lightning: 'Storms',
  snowy: 'Snow',
  'snowy-rainy': 'Sleet',
  hail: 'Hail',
};

export function conditionLabel(condition) {
  return CONDITION_LABELS[condition] || (condition ? condition[0].toUpperCase() + condition.slice(1) : '');
}

/**
 * Build the weather block from the weather entity state plus hourly and
 * daily forecasts (from weather.get_forecasts).
 */
export function buildWeather(state, hourly, daily, now = new Date()) {
  if (!state || state.state === 'unavailable' || state.state === 'unknown') return null;
  const a = state.attributes || {};
  const unit = a.temperature_unit || '°F';
  const today = (daily || []).find((d) => sameLocalDay(new Date(d.datetime), now)) || (daily || [])[0];
  const upcoming = (hourly || []).filter((h) => new Date(h.datetime) > now);

  return {
    condition: state.state,
    label: conditionLabel(state.state),
    temperature: round(a.temperature),
    unit,
    high: today ? round(today.temperature) : null,
    low: today ? round(today.templow) : null,
    hourly: upcoming
      .filter((_, i) => i % 2 === 0)
      .slice(0, 5)
      .map((h) => ({ time: h.datetime, temperature: round(h.temperature), condition: h.condition })),
    headsUp: headsUp(upcoming, unit, now),
  };
}

/**
 * One line worth reading before leaving the house: precipitation in the
 * next 12 hours, or a freeze. Returns { kind, label, at } where `at` is
 * null when it's happening now; the tablet formats the time locally.
 */
export function headsUp(hourly, unit = '°F', now = new Date()) {
  const window = hourly.filter((h) => {
    const t = new Date(h.datetime).getTime();
    return t > now.getTime() - 3600e3 && t <= now.getTime() + 12 * 3600e3;
  });

  const wet = window.find((h) => WET[h.condition] || (h.precipitation_probability ?? 0) >= 60);
  if (wet) {
    const label = WET[wet.condition] || 'Rain';
    const startsNow = new Date(wet.datetime).getTime() <= now.getTime() + 30 * 60e3;
    return { kind: 'precip', label, at: startsNow ? null : wet.datetime };
  }

  const freezing = unit.includes('C') ? 0 : 32;
  const cold = window.find((h) => typeof h.temperature === 'number' && h.temperature <= freezing);
  if (cold) {
    return { kind: 'freeze', label: 'Freezing', at: cold.datetime, temperature: round(cold.temperature) };
  }
  return null;
}

function round(n) {
  return typeof n === 'number' ? Math.round(n) : null;
}

function sameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
