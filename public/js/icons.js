import { svgIcon } from './dom.js';

const AMBER = '#F2B544';
const GREY = '#C9CFD6';
const BLUE = '#7FB2FF';

const sun = [
  ['circle', { cx: 12, cy: 12, r: 4, stroke: AMBER }],
  ['path', { d: 'M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4', stroke: AMBER }],
];
const moon = [['path', { d: 'M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z', stroke: GREY }]];
const cloud = (stroke = GREY) => ['path', { d: 'M7 18h10a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.4 1.6A3.2 3.2 0 0 0 7 18z', stroke }];
const partly = [
  ['circle', { cx: 9, cy: 9, r: 3.2, stroke: AMBER }],
  ['path', { d: 'M9 2.5v1.3M3.8 4.6l.9.9M2.5 9h1.3M14.2 4.6l-.9.9', stroke: AMBER }],
  ['path', { d: 'M8 19h9a3.5 3.5 0 0 0 .4-7 5 5 0 0 0-9.3 1.4A2.8 2.8 0 0 0 8 19z', stroke: GREY }],
];
const rain = [
  ['path', { d: 'M7 14h10a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.4 1.6A3.2 3.2 0 0 0 7 14z', stroke: GREY }],
  ['path', { d: 'M8 17l-1 3M12 17l-1 3M16 17l-1 3', stroke: BLUE }],
];
const snow = [
  ['path', { d: 'M7 14h10a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.4 1.6A3.2 3.2 0 0 0 7 14z', stroke: GREY }],
  ['path', { d: 'M8 18h.01M12 18h.01M16 18h.01M10 21h.01M14 21h.01', stroke: '#E7EAEE' }],
];
const storm = [
  ['path', { d: 'M7 14h10a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.4 1.6A3.2 3.2 0 0 0 7 14z', stroke: GREY }],
  ['path', { d: 'M12.5 14l-2 4h3l-2 4', stroke: AMBER }],
];
const fog = [
  cloud(),
  ['path', { d: 'M4 21h16', stroke: GREY }],
];
const wind = [['path', { d: 'M3 9h11a3 3 0 1 0-3-3M3 15h15a3 3 0 1 1-3 3M3 12h8', stroke: GREY }]];

const BY_CONDITION = {
  sunny: sun,
  'clear-night': moon,
  partlycloudy: partly,
  cloudy: [cloud()],
  rainy: rain,
  pouring: rain,
  snowy: snow,
  'snowy-rainy': snow,
  hail: snow,
  lightning: storm,
  'lightning-rainy': storm,
  fog,
  windy: wind,
  'windy-variant': wind,
  exceptional: storm,
};

export function weatherIcon(condition, size = 44) {
  return svgIcon(BY_CONDITION[condition] || [cloud()], { size, className: 'weather-icon' });
}
