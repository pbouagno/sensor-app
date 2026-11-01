# Telematics: live phone sensors

Live app: **https://pbouagno.github.io/sensor-app/**

Telematics is a web app that you can add to your phone's Home Screen. It shows every sensor that your phone's browser lets a web page read. Each sensor gets live charts, min, max and mean statistics, and a recorder that saves the raw readings so you can export them as CSV or JSON. The Trip tab logs a drive about once a second and scores how smooth it was.

It's plain HTML, CSS and JavaScript. There's no build step and no libraries. The look follows your default SpaceX style guide: black background, uppercase Barlow headings, Roboto Mono numbers and thin ghost buttons. It doesn't use any SpaceX names or logos.

Asset paths are relative (`./`, `icons/`, `fonts/`, `js/`) so the app works when GitHub Pages serves it from the `/sensor-app/` subpath. `.nojekyll` keeps Pages from running Jekyll on these files.

## Try it on your computer
```bash
python3 -m http.server 5175      # from this folder, then open http://localhost:5175
```
A laptop has almost no sensors, so most tiles will say "Not available". That's expected.

## Try it on your phone
Phones only allow sensors on a secure page: **https://** or localhost. Open **https://pbouagno.github.io/sensor-app/**. Then:
1. Tap **START SENSORS**. If you want the sound level too, tick "Include microphone" first.
2. On iPhone, say **Allow** to Motion & Orientation and to Location.
3. To install it, tap Share → **Add to Home Screen**. On Android, use the ⋮ menu → **Install app**.

## Screens
- **Sensors:** one tile per sensor with every axis, its unit, the update rate in Hz, the last timestamp and a live chart. Sensors this phone or browser can't provide are listed at the bottom under "Not available on this device / browser", with the reason.
- **Detail:** tap a tile to open it. You get a big chart, axis toggles, a 5/10/30/60 s time window and a Pause button. There's a Now/Min/Max/Mean table, plus a compass dial, 3D tilt phone, GPS trace, waveform or gauge where it fits.
- **Record:** start and stop recording. Every reading from every live sensor goes into the browser's database (IndexedDB), saved every 2 seconds. The screen stays on while you record if the browser supports that.
- **Sessions:** your saved recordings. You can export each one as CSV or JSON, or delete it.
- **Trip:** start and stop a trip. About once a second it stores GPS plus motion, keeps the screen on when the browser allows it, and shows current speed, elapsed time and distance. The summary has duration, distance, max and average speed (mph or km/h), elevation gain, hard brakes, hard accelerations, sharp turns, max g, and a 0–100 smooth-driving score with a short note on what lowered it. A route trace and a speed chart are drawn on a canvas.
- **Trips:** history of those drives. Open one for its summary and charts, export CSV or JSON, or delete it. Harsh-event threshold, sharp-turn threshold and speed units are on the Trip screen.
- **Device:** browser and device info, a vibration test and settings (recording rate, chart window, delete all).

## Files
| File | What it does |
|---|---|
| `index.html` | The page: top bar, the area each screen is drawn into, and the tab bar |
| `styles.css` | All the styling. The `:root` block is copied from the style guide |
| `js/util.js` | Helpers: the rolling buffer, the min/max/mean statistics and number formatting |
| `js/sensors.js` | Reads every sensor. It checks that each one exists before using it |
| `js/charts.js` | Draws the charts and pictures on a `<canvas>` by hand |
| `js/recorder.js` | Records readings to IndexedDB and exports CSV or JSON |
| `js/trip-math.js` | Trip distance, harsh events and the 0–100 score. No browser APIs, so the tests can run it |
| `js/trip.js` | Logs a trip at about 1 Hz, stores it in IndexedDB, and holds the screen awake |
| `js/db.js` | A small wrapper around IndexedDB (recordings and trips) |
| `js/app.js` | The screens, the tabs and the update loop |
| `sw.js` | The service worker that makes the app work offline. **Bump `CACHE_NAME` whenever you edit files** (it is `telematics-v3` now), or phones keep the old copy |
| `tests/trip.test.js` | Checks haversine distance, harsh-event detection and the score |
| `manifest.json` | The app name, icons and colors used when it's installed |
| `fonts/`, `icons/`, `screenshots/` | Self-hosted fonts, home-screen icons, and reference screenshots |
| `make-qr.js` | Writes `screenshots/qr.png` for a URL (`node make-qr.js <url>`) |
| `.nojekyll` | Tells GitHub Pages to publish the files as-is |
| `.github/workflows/pages.yml` | Publishes this folder to GitHub Pages on each push to `main` |

## Tests
```bash
node tests/trip.test.js
```

## The CSV format
The CSV has one line per value: `time_iso, elapsed_s, sensor, field, value, unit`. This "long" layout is easy to filter, or to turn into a pivot table in Excel or Google Sheets.

## Trip score
Distance is the sum of great-circle steps between GPS points. A step faster than 90 m/s is treated as a GPS glitch and dropped. Hard brakes and hard accelerations are longitudinal acceleration past the threshold (default 0.3 g): the change in GPS speed when the browser reports it, otherwise acceleration out the top of the phone. A harsh stretch counts once, not once per sample. Sharp turns are a turn rate past the threshold (default 45 °/s), from the gyroscope about gravity or from the change in heading. The score starts at 100. Each hard brake costs 8 points (40 max), each hard acceleration 6 (30 max), each sharp turn 4 (20 max), and a peak above 0.6 g costs up to 15 more.

## The trip CSV
One row per second: `time_iso, elapsed_s, lat, lon, accuracy_m, alt_m, speed_mps, heading_deg, ax, ay, az, long_accel_mps2, yaw_dps, g`. The JSON file is the same samples plus the summary.

## Known limits
- Phones pause web pages when the screen locks or you switch apps, so readings, recording and the trip log stop until you come back.
- The microphone level is dBFS, measured relative to the mic's maximum. It isn't calibrated decibels.
- Each browser reports motion axes in its own frame. Check the numbers against a known position, such as the phone lying flat, before you trust them.
- Trip distance and speed need a location fix. A laptop will usually score a trip with no route.
