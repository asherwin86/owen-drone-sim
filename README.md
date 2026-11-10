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

## Turn on the realistic 3D Earth (free)

Without a token you get a basic satellite map. With a **free Cesium token** you get Google's Photorealistic 3D Tiles: real, fully textured buildings, trees and landmarks everywhere (the Eiffel Tower, the Opera House, your own street).

1. Make a free account at <https://ion.cesium.com> (no credit card).
2. Open **Access Tokens** and copy the **Default token**.
3. In the game: **Settings → Cesium token**, paste it, press **Test keys**, then **Save** and **Restart now**.

Good to know:
- The free plan is for **personal, non-commercial** use and includes about **1,000 map sessions a month** (a session starts each time the game loads the world). Cesium treats this limit as soft. Check <https://cesium.com/platform/cesium-ion/pricing/> for the current rules.
- Google requires place search to use Google's own search, so the World tab search uses Google's geocoder through Cesium. Google's logo and credits are shown in the corner and must stay visible.
- The game must be running (the `start-game.bat` window or `npm run web` must stay open) for Save to work. Tokens are saved to `%USERPROFILE%DroneSimconfig.json`, outside the repo, so they never get uploaded. Never share your token.

### Optional: use your own Google Maps key instead

Advanced, and Google may charge for it. Enable the **Map Tiles API** in Google Cloud, create a key, and paste it in **Settings → Google Maps API key**. If you restrict the key to websites, allow `http://127.0.0.1:47831/*`. Never put a Google key in the repo.

### Free basic 3D buildings for every player (for the repo owner)

If `PUBLIC_ION_TOKEN` in `js/public-config.js` holds a **restricted** token, every player gets real terrain and plain grey 3D buildings without any setup (the realistic version still needs their own free token, so your monthly quota is not used up):

1. Sign in at <https://ion.cesium.com/tokens> and **Create token**.
2. Tick only **assets:read**, select only *Cesium World Terrain*, the imagery asset and *Cesium OSM Buildings* (not the Google Photorealistic asset), and set **Allowed URLs** to `http://127.0.0.1:47831` and `http://localhost:47831`.
3. Paste it into `js/public-config.js` and commit. It is safe to be public because it is read-only and locked to those assets and addresses. **Never commit a Google key or a full-access token.**

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
js/world.js           Cesium globe, map sources, ground/obstacle probes
js/droneModel.js      drone 3D model built in code
js/data.js            drones, job types, landmarks (edit to rebalance!)
```

Progress is saved to `%USERPROFILE%\DroneSim\save.json`.

## Credits

Map data © Google / Cesium / Esri depending on the map source in use. The attribution is shown in the bottom-left corner of the game and must be kept visible.
