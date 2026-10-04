# Home Dashboard

A wall-mounted household dashboard: a fullscreen web page on an Android tablet (Fully Kiosk Browser), fed by Home Assistant through a small server on the NAS. It does not use the HA frontend.

```
Tablet (Fully Kiosk) ──HTTP(S)──> Dashboard server (Docker on NAS) ──> Home Assistant REST + WebSocket
   static page + SSE                holds HA_TOKEN, filters data
```

- The tablet never sees the HA token. The server reads HA and sends the tablet one JSON snapshot, then pushes updates over Server-Sent Events.
- The only write is `scene.turn_on`, and only for scenes listed in the config.
- Calendars marked `busyOnly` lose their titles, locations and notes **on the server**, so those details never reach the tablet.
- No npm dependencies. The server uses only Node built-ins (`http`, `fetch`, `WebSocket`). The client is plain ES modules and CSS with no build step, so there is nothing to keep updated.

Design mockups: https://claude.ai/code/artifact/ac29bb15-b397-4890-b2bc-3725fca7be3c

## What's built (priority 1)

| Feature | Notes |
|---|---|
| Week agenda | All configured calendars, color + name on every item, filter chips (remembered on the tablet), tap → detail pane. Read-only. |
| Free/busy calendars | `"busyOnly": true` shows "Busy" time blocks only. |
| Weather | Current conditions, high/low, five hourly temps, and a one-line heads-up (rain, snow or storms in the next 12 h, otherwise a freeze). |
| Light scenes | Big buttons, "N of M lights on", and the last-activated scene highlighted. |
| House at a glance | Lists only what's off-normal (unlocked, open, offline), plus the thermostat. |
| Heads up | Upcoming items (next 4 days) from calendars marked `"headsUp": true`, e.g. bins. |
| Night / idle | Night window → dim ambient clock view; touch or motion wakes it for `wakeMinutes`. During the day, after `idleMinutes` the view resets to the next event. Brightness is set through Fully Kiosk. Pixel shift every hour. |
| Cameras | Tap a camera button for a near-live view (stills every 2 s, scaled by HA). Optional triggers (doorbell, person, motion) pop the view open and wake the screen, even at night. |
| Resilience | Keeps the last good data if HA or a calendar fails, shows a small "Reconnecting" / "Home Assistant offline" pill, and reloads itself when the server is redeployed. |

## Run it locally (no HA needed)

```sh
npm run dev          # mock data, auto-restart on change
# open http://localhost:8080 — Chrome DevTools → device toolbar → 1280×800
npm test
```

With no `HA_URL`, the server uses **mock data** made relative to the current time and the example config. A "Demo data" pill shows in the corner.

Testing switches:

| | |
|---|---|
| `?mode=night` / `?mode=day` | Force a view |
| `?sim=1` | The Fully Kiosk stub dims the page to show brightness changes |
| press `m` | Simulate a Fully Kiosk motion event |
| mouse move / click | Counts as activity, like a touch |

## Configuration

**Env vars** (secrets and deployment):

| Var | |
|---|---|
| `HA_URL` | e.g. `http://homeassistant.local:8123`. Unset → mock mode. |
| `HA_TOKEN` | Long-lived token for a dedicated HA user. |
| `CONFIG_PATH` | Household config JSON (default `config/dashboard.json`; `/config/dashboard.json` in Docker). |
| `TZ` | Server time zone. Set it to the household's; it decides where "today" starts when fetching calendars. |
| `ACCESS_KEY` | Optional shared key. Open the dashboard once with `?key=…` and a year-long cookie is set. |
| `TLS_CERT`, `TLS_KEY` | Optional: serve HTTPS directly instead of through a reverse proxy. |
| `PORT`, `HOST` | Default `8080`, `0.0.0.0`. |
| `MOCK=1` | Force mock data. |

**Household config:** copy `config/dashboard.example.json` to `config/dashboard.json` and fill in your entity IDs:

- `calendars[]`: `entity`, `name`, `color`, optional `busyOnly`, `headsUp`
- `weather.entity`
- `scenes[]`: `entity` (must be `scene.*`), `name`
- `lights`: `null` counts every `light.*` entity (light groups are skipped); or give an explicit list, which may include `switch.*` entities for smart wall switches
- `house[]`: `entity`, `name`, `normal` (state or list of states), optional `labels` (`{"on": "Open"}`)
- `cameras[]`: `entity` (must be `camera.*`, e.g. UniFi Protect's `camera.east_garage_high_resolution_channel`), `name`, optional `triggers` (entity IDs that pop the view open: a `binary_sensor` turning on, e.g. person/motion detected, or an `event.*` doorbell ring) and `popupSeconds` (default 60). Each camera gets a button on the Home card that opens a view refreshing every 2 s; the server fetches the stills from HA (`/api/camera_proxy`), so the tablet never needs the HA token. A view opened by hand closes after 2 min
- `climate`: `entity`, `name`
- `appliances[]`: `name`, plus `remaining` (a finish-time timestamp sensor, a duration sensor such as minutes left, or an `H:MM` string) and/or `state` (the machine's run state). Optional `runningStates` lists the states that mean "running"; by default anything except off/idle/finished/etc. counts. Shown as "Done in 23 min" on the Home card and night view only while running
- `display`: `nightStart`, `nightEnd`, `wakeMinutes`, `idleMinutes`, `brightnessDay`/`brightnessNight` (0–255), `screenOffAfterMinutes` (null = never), `pixelShift`
- `agendaDays` (1–14), `clock24h`

## Home Assistant setup

1. Create a dedicated user (e.g. `dashboard`), non-admin, and generate a long-lived token on its profile page.
2. Add Google / CalDAV / ICS calendars to HA so each one is a `calendar.*` entity. The dashboard reads them with `GET /api/calendars/<entity>`.
3. Find entity IDs in Developer Tools → States: calendars, `weather.*`, `scene.*`, locks, covers and door sensors, and the thermostat.

HA endpoints used: `GET /api/states`, `GET /api/calendars/<id>?start&end`, `POST /api/services/weather/get_forecasts?return_response`, `POST /api/services/scene/turn_on`, and WebSocket `/api/websocket` with `subscribe_events: state_changed`.

Refresh: entity states arrive live over the WebSocket. Calendars are re-read every 5 min and whenever a calendar entity changes state. Forecasts are re-read every 30 min.

## Deploy on the Synology NAS

1. Copy the repo to the NAS (e.g. `/volume1/docker/home-dashboard`).
2. `cp config/dashboard.example.json config/dashboard.json` and edit it. `cp .env.example .env` and set `HA_TOKEN`, `HA_URL`, `TZ`.
3. Container Manager → Project → Create → choose that folder (it uses `compose.yaml`) → build and start.
4. **HTTPS:** Control Panel → Login Portal → Advanced → Reverse Proxy: `https://dashboard.<your-domain>:443` → `http://localhost:8080`, with a Let's Encrypt certificate from Control Panel → Security → Certificate. In the rule's Custom Header, add the WebSocket preset; SSE works through it, and the server sends `X-Accel-Buffering: no` so nginx doesn't buffer it.
5. Check `https://dashboard…/healthz`.

## Fully Kiosk setup (tablet)

- Start URL: the HTTPS dashboard URL (add `?key=…` once if `ACCESS_KEY` is set).
- Web Content Settings → **Enable JavaScript Interface** (the page needs `window.fully`).
- Motion Detection → enable (front camera). The page binds `onMotion` to wake itself. Also set "Turn screen on on motion" if you use `screenOffAfterMinutes`.
- Device Management → keep screen on; Kiosk mode on; landscape lock.
- Samsung: Battery → Protect battery (charge cap).
- Optional: HA's Fully Kiosk integration (Remote Admin on the LAN) for house-wide triggers such as bedtime dimming or waking the screen when a door opens. That path is separate from the page.

Layout is fixed for 1280×800 CSS px (1920×1200 at DPR 1.5). Check this on the real device; if Fully reports a different viewport, set its zoom or page scale.

## Layout

```
server/
  index.js     entry: config → HA client (or mock) → store → HTTP(S)
  app.js       routes: /api/snapshot, /api/stream (SSE), POST /api/scenes/:id, static, /healthz
  ha.js        HA REST + WebSocket client
  mock.js      same interface, fake data
  store.js     caches HA data, polls calendars/forecast, builds the snapshot
  calendar.js  event normalisation + busy-only stripping
  weather.js   forecast → current/hourly/heads-up
  house.js     exceptions, light count, climate, current scene
public/
  index.html, css/app.css, fonts/ (Outfit + Atkinson Hyperlegible, OFL, self-hosted)
  js/app.js      state + rendering
  js/format.js   date/agenda logic (pure; unit-tested in Node)
  js/display.js  night/idle/brightness/motion/pixel shift + Fully Kiosk stub
test/          node:test suites (no dependencies)
```

## Not built yet

- Priority 2+: appliance done, who's home, doorbell snapshot, leave-by times, chores/lists/meal plan, photo frame, etc.
- Open questions from the brief: the real calendar/scene/sensor entity IDs (the example config holds placeholders) and the final NAS reverse-proxy hostname.
