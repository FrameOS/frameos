# Scene store TODO — 50 missing scenes

Ideas for practical scenes the store at [scenes.frameos.net](https://scenes.frameos.net) doesn't have yet.
Focus: glanceable, high-contrast, low-refresh content that plays to e-ink strengths (always-on, no glow, readable in sunlight). Cadence notes assume typical e-ink refresh budgets (Spectra 6 ≈ minutes, faster B/W panels ≈ seconds).

Already covered (don't duplicate): photo slideshows (Google Photos, Immich, SD card, Unsplash, Wikimedia, URL), curated art galleries, monthly calendar, iCal agenda, weather, chart, GitHub stars, XKCD, counter, message board, Chromium screenshot, Ken Burns, RTSP webcam, MiniGPT, OpenAI image, haiku of the hour, bird field journal, visited world map, DVD logo bounce — plus the ticked items below (in the store since 2026-08-30).

Legend: **S** = simple (one HTTP source + layout), **M** = medium (auth / multiple sources / state), **L** = larger (protocol work, new app, or heavy layout).

## Clocks & time

- [x] **Word clock** (`/s/word-clock`) — "IT IS HALF PAST NINE" in a big letter grid or as typeset text. The classic e-ink build; zero dependencies. Refresh every 5 min. **S**
- [x] **Big typographic clock** (`/s/big-typographic-clock`) — huge numerals filling the panel, date beneath. Optional dithered background from the art galleries. Works best on fast-refresh B/W panels (per-minute). **S**
- [x] **Analog clock face** (`/s/analog-clock-face`) — SVG-rendered dial, selectable styles (station clock, minimal, roman). Refresh per minute. **S**
- [x] **Year progress / memento mori** (`/s/year-progress-memento-mori`) — dot grid of the year (or a life calendar in weeks), today highlighted, percentage complete. Refresh daily; the definition of low-power content. **S**
- [ ] **Countdown / count-up board** — "142 days until the wedding", "38 days smoke-free". Multiple configurable events, biggest one dominates. Refresh daily. **S**
- [ ] **Week planner** — 7-column layout of the coming week from an .ics feed; today's column emphasized. Complements the existing monthly Calendar and linear agenda. Refresh hourly. **M**

## Daily briefing

- [ ] **Morning dashboard** — one curated screen: date, weather now + today, next 3 calendar events, a todo list, sunrise/sunset. The single most-requested e-ink use case; a designed layout rather than a DIY split-screen assembly. **M**
- [ ] **News headlines (RSS)** — top N headlines from any RSS/Atom feeds, newspaper-style typography. Refresh every 30–60 min. **S**
- [ ] **Front page, retro newspaper** — aggregated feeds typeset like a broadsheet: masthead, columns, one dithered lead image. E-ink looks *exactly* like newsprint; lean into it. Refresh a few times a day. **L**
- [ ] **On This Day** — historical events, births, deaths for today's date from the Wikipedia API. Refresh daily. **S**
- [ ] **Quote of the day** — curated quote, big serif type, attribution. Optional themes (stoic, literary, humorous). Refresh daily. **S**
- [ ] **Word of the day** — word, pronunciation, definition, example sentence (Wiktionary/Wordnik). Great for kids' rooms and language learners. Refresh daily. **S**
- [ ] **Poem of the day** — from PoetryDB or a bundled anthology; typography-first layout. Refresh daily. **S**

## Nature & sky

- [ ] **Sun & moon panel** — sunrise/sunset, golden hour, day length trend, moon phase drawn as a dithered disc. All computable offline from lat/long. Refresh daily. **S**
- [ ] **Tonight's sky** — visible planets, ISS passes, meteor showers, moon phase (Open-Notify + computed ephemeris). Refresh daily. **M**
- [ ] **Tide table** — next high/low tides as a smooth curve with "now" marker (NOAA / WorldTides / Stormglass). Essential for coastal homes; nothing like it in the store. Refresh hourly. **M**
- [ ] **Air quality** — AQI, PM2.5, pollen where available (Open-Meteo air quality API, no key needed). Color-banded gauge that degrades gracefully to grayscale. Refresh hourly. **S**
- [ ] **Pollen & allergy forecast** — per-allergen levels for the week (Open-Meteo / Ambee). Refresh daily. **S**
- [ ] **Garden almanac** — what to sow/plant/harvest this month for your hardiness zone, plus frost warning from the forecast. Refresh daily. **M**
- [ ] **Surf / snow report** — wave height & period or snow depth & fresh cm for a chosen spot (Open-Meteo marine / resort APIs). Refresh a few times a day. **M**
- [ ] **Earthquakes nearby** — recent quakes from the USGS GeoJSON feed on a simple map, magnitude-scaled markers. Refresh hourly. **M**

## Home & family

- [ ] **Family status board** — shared message of the day + today's events per family member + whose-turn chore rotation. Editable from the cloud or a webhook. **L**
- [ ] **Todo list** — Todoist / CalDAV tasks / plain webhook-fed list, big checkboxes, done items struck through. Refresh on change or every 15 min. **M**
- [ ] **Grocery list** — shared shopping list (webhook / cloud state / Bring-style), grouped by aisle. Glance on the way out the door. **M**
- [ ] **Chore wheel** — rotating assignment of household chores by day/week, per person. Pure local state. Refresh daily. **S**
- [ ] **Habit tracker** — streak grid (GitHub-contribution style) per habit; tick via GPIO button, webhook, or cloud. **M**
- [ ] **Meal plan** — this week's dinners from a simple editable list or an .ics feed; tonight's meal large, rest small. Refresh daily. **S**
- [ ] **Recipe of the day** — one recipe with ingredients and steps (TheMealDB or bundled collection); kitchen-friendly big type. Refresh daily. **S**
- [ ] **Birthdays & anniversaries** — upcoming from an .ics or a simple list; "Sofia turns 8 in 3 days". Refresh daily. **S**
- [ ] **Package tracker** — status of inbound parcels (AfterShip / 17track / carrier APIs), one line each with progress bar. Refresh hourly. **M**

## Smart home & homelab

- [ ] **Home Assistant dashboard** — grid of chosen HA entities (temps, doors, lights, media) via the HA REST API; the HA add-on already ships FrameOS so demand is proven. **M**
- [ ] **Indoor climate** — temperature / humidity / CO₂ per room from MQTT or HA, with 24 h sparklines. Refresh every few minutes. **M**
- [ ] **Solar & battery** — PV production today, battery %, grid import/export as a flow diagram (HA / SolarEdge / Fronius APIs). Refresh every 5–15 min. **M**
- [ ] **Electricity price today** — hourly dynamic-tariff prices (Nordpool / aWATTar / Tibber) as a bar strip, cheapest hours highlighted — "run the dryer at 14:00". Huge in Europe. Refresh daily + hourly marker. **M**
- [ ] **Network status** — WAN up/down, ping/jitter, last speedtest, Pi-hole blocked-today. Refresh every 5 min. **M**
- [ ] **Homelab monitor** — Uptime Kuma / Prometheus summary: services up, disk fill, last backup age. A "wall of green" you glance at. Refresh every 5 min. **M**
- [ ] **3D printer status** — job name, progress %, ETA, nozzle/bed temps from OctoPrint or Moonraker; layer-cam thumbnail optional. Refresh per minute while printing. **M**

## Transport & out-the-door

- [ ] **Transit departures** — next buses/trains for chosen stops (GTFS-RT or local transit APIs); the classic hallway frame. Refresh every 1–2 min on fast panels. **L**
- [ ] **Commute ETA** — current drive time to work/school with traffic (OSRM + traffic provider, or Google/HERE), colored vs. baseline. Refresh every 5 min in the morning window. **M**
- [ ] **Fuel prices nearby** — cheapest stations around you (Tankerkönig DE, fuel APIs elsewhere). Refresh a few times a day. **M**
- [ ] **Flights overhead** — what's that plane? Nearest aircraft from OpenSky/ADS-B: flight number, origin→destination, altitude. Surprisingly delightful. Refresh per minute. **M**

## Money

- [ ] **Stock & ETF watchlist** — a few tickers with price, day change, and 30-day sparkline. Refresh every 15 min in market hours. **M**
- [ ] **Crypto prices** — same layout for coins (CoinGecko, no key). Refresh every 15 min. **S**
- [ ] **Exchange rates** — chosen currency pairs with trend arrows (ECB / exchangerate.host). Refresh daily. **S**

## Learning & play

- [ ] **Chess puzzle of the day** — daily puzzle from the Lichess API, board rendered as crisp SVG; solution revealed on next refresh or button press. **M**
- [ ] **Sudoku of the day** — generated locally, printed like a newspaper puzzle; solution on button press. Pairs with a frame in the kitchen and a pencil. **M**
- [ ] **Language flashcard** — word or phrase of the hour in the target language with translation and example; spaced-repetition-ish rotation from a bundled deck or CSV URL. **M**
- [ ] **Trivia / fact of the day** — Numbers API / Open Trivia DB; question at breakfast, answer at dinner (two-phase daily refresh). **S**
- [ ] **Element of the day** — periodic table cell blown up large: symbol, properties, one fun fact. Nerdy, gorgeous in type. Refresh daily. **S**

## Sports & leisure

- [ ] **My team's fixtures & scores** — last result + next match + league position for a chosen club (football-data.org, TheSportsDB). Refresh hourly, per-minute on match day. **M**
- [ ] **F1 race weekend** — countdown to next session, latest results, driver standings (Ergast/Jolpica API). Refresh daily. **M**
- [ ] **Strava week** — km this week vs. last, latest activity with route polyline drawn as a line map. OAuth needed. Refresh hourly. **L**
- [ ] **Now playing** — current Spotify / Sonos / last.fm track with heavily dithered album art. Only sensible on fast-refresh panels; document that constraint. **M**
- [ ] **Reading tracker** — current book cover, % progress, pace vs. goal (Hardcover API / manual state). Refresh daily. **M**

## Notes for implementation

- Anything marked **S** is a good "community first PR" candidate — one data app + one layout.
- Prefer keyless public APIs (Open-Meteo family, USGS, Wikipedia, CoinGecko, Lichess, PoetryDB) so scenes work out of the box.
- Scenes with per-minute cadence (transit, now playing, big clock) should state panel expectations in their description — Spectra 6 owners shouldn't install them expecting minute refreshes.
- Several ideas (family board, grocery list, habit tracker) want shared writable state → good drivers for cloud scene-state / webhook features.
