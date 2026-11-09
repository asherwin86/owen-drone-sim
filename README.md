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

## Turn on the real 3D Earth (Google Maps)

Without a key you get a free satellite map with a simple stand-in Eiffel Tower. With a Google Maps key you get Google's Photorealistic 3D Tiles: real buildings, trees and landmarks everywhere.

1. In Google Cloud, create a project and enable the **Map Tiles API**, then create an API key. (Google may ask for billing details; check their current pricing and terms.)
2. In the game: **Settings → Google Maps API key**, paste it, **Save**, then **Restart now**.

The key is saved in `config.json` on your computer. That file is git-ignored so it never gets uploaded. Never share your key or commit it.

Optional: a free [Cesium ion](https://ion.cesium.com) token gives real terrain and 3D buildings without Google.

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

Xbox-style gamepads work too: left stick = turn and up/down, right stick = move, Y = camera, Start = pause.

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
