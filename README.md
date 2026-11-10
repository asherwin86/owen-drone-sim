# Owen's Drone Sim

A drone delivery game set on the whole Earth. Take jobs (like food delivery), earn money, buy better drones, and fly over real cities and landmarks like the Eiffel Tower.

Built from Owen's concept art (see `concept/concept-art.jpg`): a main menu, a Jobs screen, a Drones shop, and a flight view with a route progress bar.

**Tech:** Electron (Windows desktop app) + [CesiumJS](https://cesium.com/platform/cesiumjs/) (the whole-Earth 3D engine). No Unity, no Roblox.

## Play

Double-click **`start-game.bat`**. The first run installs everything it needs.

Or from a terminal:

```
npm install
npm start        # desktop window
npm run web      # or: play in a browser at http://127.0.0.1:47831
```

Needs [Node.js](https://nodejs.org) 20 or newer.

## The world: free for everyone, forever

The game works out of the box with **no account, no key and no limits**. It builds a 3D Earth from open data:

| Part | Source |
| --- | --- |
| Real mountains and hills | [Terrain Tiles on AWS](https://registry.opendata.aws/terrain-tiles/) (open data) |
| Satellite photos on the ground | Esri World Imagery |
| 3D buildings with real heights, roofs and windows | [OpenFreeMap](https://openfreemap.org) / [OpenStreetMap](https://www.openstreetmap.org/copyright) |

Buildings are generated in the game from OpenStreetMap outlines and heights, so they look like a detailed city model (brick, stone, concrete and glass with windows), not photographs. Landmarks such as the Eiffel Tower are simple stand-ins. Attribution is shown in the corner of the game and must stay visible.

Needs an internet connection. If you are offline the game falls back to a flat satellite map.

### Optional upgrade: photo-realistic 3D (still free)

For real photographic 3D (the actual Eiffel Tower, trees, every street) add a **free Cesium token**:

1. Make a free account at <https://ion.cesium.com> (no credit card).
2. Open **Access Tokens** and copy the **Default token**.
3. In the game: **Settings → Cesium token**, paste it, press **Test keys**, then **Save** and **Restart now**.

Good to know:
- The free plan is for **personal, non-commercial** use and includes about **1,000 map sessions a month** (a session starts each time the game loads the world), so it is an upgrade for each player, not something one account can share. Cesium treats the limit as soft. See <https://cesium.com/platform/cesium-ion/pricing/>.
- Google requires place search to use Google's own search, so with photo-realistic 3D the World tab search uses Google's geocoder through Cesium. Google's logo and credits are shown in the corner and must stay visible.
- Past the monthly limit the game still works: choose **Settings → Map → Free 3D world only** (or just remove the token) and you are back on the unlimited free world.
- The game must be running (the `start-game.bat` window or `npm run web` must stay open) for Save to work. Tokens are saved to `%USERPROFILE%\DroneSim\config.json`, outside the repo, so they never get uploaded. Never share your token.

### Optional: use your own Google Maps key instead

Advanced, and Google may charge for it. Enable the **Map Tiles API** in Google Cloud, create a key, and paste it in **Settings → Google Maps API key**. If you restrict the key to websites, allow `http://127.0.0.1:47831/*`. Never put a Google key in the repo.

## How to play

1. **Play → Jobs**: pick a delivery. Fly into the glowing **orange beam** to pick up, then the **green beam** to deliver.
2. Get paid. Faster and smoother flying earns bonuses. Bumping into things costs money.
3. **Drones**: spend your money on faster drones with bigger batteries and more cargo. New job types unlock as you can carry more (Food, Parcels, Medical Rush, Heavy Freight).
4. **World**: move to a famous place or search for anywhere on Earth. **Free Fly** has no battery limit.

If the battery runs out the drone lands and the job fails, but you never lose money.

### Controls

| Key | Action |
| --- | --- |
| W A S D | move forward / left / back / right |
| Q E (or ← →) | turn |
| Space / Shift | up / down |
| V | switch chase / first-person camera |
| Esc | pause |
| F11 | full screen (desktop app) |

### Controller (Xbox / PlayStation / any standard gamepad)

Plug it in and press a button. The game shows controller hints automatically.

| Control | In flight |
| --- | --- |
| Right stick | fly forward / back / slide left / slide right |
| Left stick | turn (left/right), up / down (up/down) |
| RT / LT | up / down |
| LB / RB | turn left / right |
| Y | switch camera |
| Start | pause (B resumes) |

| Control | In menus |
| --- | --- |
| D-pad or left stick | move the highlight (left/right changes dropdowns and sliders) |
| A | select |
| B | back |
| LB / RB | switch Jobs / Drones / World tabs |

The controller buzzes when you bump into something, pick up and deliver. You can turn that off in Settings. If your pad is not detected, press any button on it while the game window is selected.

## Project layout

```
main.js, preload.js   Electron window
server.js             tiny local server + save/config files
index.html, css/      screens and styling
js/game.js            menus, jobs, shop, flight sessions, HUD
js/flight.js          drone physics, input, cameras, collisions
js/world.js           Cesium globe, map sources, ground/building lookups
js/terrain.js         free real-world terrain (AWS open data)
js/buildings.js       free 3D buildings from OpenStreetMap vector tiles
js/mvt.js             tiny vector-tile decoder
js/droneModel.js      drone 3D model built in code
js/data.js            drones, job types, landmarks (edit to rebalance!)
```

Progress is saved to `%USERPROFILE%\DroneSim\save.json`.

## Credits

Map data © Google / Cesium / Esri depending on the map source in use. The attribution is shown in the bottom-left corner of the game and must be kept visible.
