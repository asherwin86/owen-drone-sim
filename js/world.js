// World: the Cesium globe, map source selection, and ground/obstacle probing.
const Cesium = window.Cesium;

const QUALITY = {
  high: { sse: 12, resolution: 1 },
  medium: { sse: 20, resolution: 1 },
  low: { sse: 32, resolution: 0.75 },
};

export class World {
  constructor() {
    this.viewer = null;
    this.scene = null;
    this.mode = 'basic'; // 'google' | 'ion' | 'basic'
    this.statusText = '';
    this.tilesets = [];
    this.excluded = []; // objects ignored by ray probes (drone, beacons)
    this.permanentExcluded = []; // placeholder landmarks etc. (never count as ground)
    this.probeOk = true;
  }

  get ignoreList() {
    return [...this.permanentExcluded, ...this.excluded];
  }

  async init(containerId, cfg, quality = 'high') {
    this.viewer = new Cesium.Viewer(containerId, {
      baseLayer: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      shouldAnimate: true,
      msaaSamples: 1,
    });
    const viewer = this.viewer;
    const scene = (this.scene = viewer.scene);

    scene.screenSpaceCameraController.enableInputs = false;
    scene.globe.depthTestAgainstTerrain = true;
    scene.globe.baseColor = Cesium.Color.fromCssColorString('#0b1a2e');
    scene.skyAtmosphere.show = true;
    scene.fog.enabled = true;
    scene.postProcessStages.fxaa.enabled = true;
    scene.highDynamicRange = false;
    scene.camera.frustum.near = 0.5;

    // Daylight at the location (≈ 3pm local solar time)
    this.setDaylight(2.3, 48.9);

    await this.loadMapSource(cfg);
    this.applyQuality(quality);
    return this;
  }

  setDaylight(lonDeg, latDeg) {
    const now = new Date();
    const utcHours = (15 - lonDeg / 15 + 24) % 24;
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Math.floor(utcHours), Math.round((utcHours % 1) * 60)));
    this.viewer.clock.currentTime = Cesium.JulianDate.fromDate(d);
    this.viewer.clock.shouldAnimate = false;
  }

  async loadMapSource(cfg) {
    const viewer = this.viewer;
    const scene = this.scene;
    const errors = [];

    if (cfg.googleMapsApiKey) {
      try {
        const ts = await Cesium.createGooglePhotorealistic3DTileset(
          { key: cfg.googleMapsApiKey },
          { maximumScreenSpaceError: 12 }
        );
        scene.primitives.add(ts);
        this.tilesets.push(ts);
        scene.globe.show = false;
        this.mode = 'google';
        this.statusText = 'Google Photorealistic 3D Earth';
        return;
      } catch (e) {
        console.warn('Google tiles failed', e);
        errors.push('Google Maps key did not work (' + (e.message || e) + ')');
      }
    }

    if (cfg.cesiumIonToken) {
      try {
        Cesium.Ion.defaultAccessToken = cfg.cesiumIonToken;
        viewer.scene.setTerrain(Cesium.Terrain.fromWorldTerrain());
        viewer.imageryLayers.add(Cesium.ImageryLayer.fromWorldImagery());
        const osm = await Cesium.createOsmBuildingsAsync();
        scene.primitives.add(osm);
        this.tilesets.push(osm);
        this.mode = 'ion';
        this.statusText = 'Cesium terrain + 3D buildings';
        return;
      } catch (e) {
        console.warn('Cesium ion failed', e);
        errors.push('Cesium ion token did not work');
      }
    }

    // Basic map: free satellite imagery, flat ground.
    try {
      const provider = await Cesium.ArcGisMapServerImageryProvider.fromUrl(
        'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
        { enablePickFeatures: false }
      );
      viewer.imageryLayers.addImageryProvider(provider);
    } catch (e) {
      console.warn('Satellite imagery failed, using OpenStreetMap', e);
      viewer.imageryLayers.addImageryProvider(
        new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' })
      );
    }
    this.mode = 'basic';
    this.statusText = 'Basic map (add a Google Maps key in Settings for the full 3D Earth)';
    if (errors.length) this.statusText = errors.join('. ') + '. Using basic map.';
    this.addLandmarkPlaceholders();
  }

  applyQuality(q) {
    const cfg = QUALITY[q] || QUALITY.high;
    for (const ts of this.tilesets) ts.maximumScreenSpaceError = cfg.sse;
    this.scene.globe.maximumScreenSpaceError = Math.max(1.5, cfg.sse / 8);
    this.viewer.resolutionScale = cfg.resolution * Math.min(window.devicePixelRatio || 1, 1.5);
  }

  /** Stand-in Eiffel Tower for the basic map (the real one appears with Google 3D tiles). */
  addLandmarkPlaceholders() {
    const mk = (lon, lat, h0, h1, r0, r1) => {
      const mid = (h0 + h1) / 2;
      const ent = this.viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat, mid),
        cylinder: {
          length: h1 - h0,
          topRadius: r1,
          bottomRadius: r0,
          slices: 4,
          fill: true,
          material: Cesium.Color.fromCssColorString('#6b5a47').withAlpha(0.55),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('#2a2118'),
          numberOfVerticalLines: 4,
        },
      });
      this.permanentExcluded.push(ent);
    };
    const lon = 2.2945, lat = 48.8584;
    mk(lon, lat, 0, 57, 42, 26);
    mk(lon, lat, 57, 115, 26, 13);
    mk(lon, lat, 115, 276, 13, 4);
    mk(lon, lat, 276, 330, 4, 0.8);
  }

  /** Resolves when nearby map tiles are loaded (or after a timeout). */
  waitForTiles(timeoutMs = 12000) {
    return new Promise((resolve) => {
      const start = performance.now();
      let stable = 0;
      const check = () => {
        const globeDone = this.scene.globe.show ? this.scene.globe.tilesLoaded : true;
        const tsDone = this.tilesets.every((t) => t.tilesLoaded);
        if (globeDone && tsDone) stable++;
        else stable = 0;
        if (stable >= 8 || performance.now() - start > timeoutMs) return resolve();
        requestAnimationFrame(check);
      };
      check();
    });
  }

  /** Ground (or roof) height at lon/lat degrees. Falls back to 0. */
  async sampleGround(points) {
    // points: [{lat, lon}] -> [heightMeters]
    try {
      const carts = points.map((p) => Cesium.Cartographic.fromDegrees(p.lon, p.lat));
      if (this.scene.sampleHeightSupported) {
        const res = await this.scene.sampleHeightMostDetailed(carts, this.ignoreList);
        return res.map((c) => (c && Number.isFinite(c.height) ? c.height : 0));
      }
    } catch (e) {
      console.warn('sampleHeightMostDetailed failed', e);
    }
    return points.map(() => 0);
  }

  /** Distance from origin along dir to the first surface, or undefined. */
  rayDistance(origin, dir) {
    if (!this.probeOk) return undefined;
    try {
      if (!this.scene.pickPositionSupported) {
        this.probeOk = false;
        return undefined;
      }
      const ray = new Cesium.Ray(origin, dir);
      const hit = this.scene.pickFromRay(ray, this.ignoreList, 0.1);
      if (hit && hit.position) return Cesium.Cartesian3.distance(origin, hit.position);
    } catch (e) {
      console.warn('Ray probe failed, collisions off', e);
      this.probeOk = false;
    }
    return undefined;
  }
}
