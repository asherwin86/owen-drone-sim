// A FREE, shared Cesium ion token that every player uses by default, so everyone gets
// real terrain + 3D buildings without setting anything up.
//
// IMPORTANT: this file is public (it is in the GitHub repo). Only put a RESTRICTED
// token here, never a full-access one. Create it at https://ion.cesium.com/tokens :
//   - Scopes: tick ONLY "assets:read"
//   - Assets: select only  Cesium World Terrain (1), Bing/Sentinel imagery (2, 3954), Cesium OSM Buildings (96188)
//   - Allowed URLs: http://127.0.0.1:47831   (and http://localhost:47831)
// Do NOT include the "Google Photorealistic 3D Tiles" asset (2275207): the shared token
// only gives basic grey buildings on purpose, so one account's monthly photorealistic
// quota is not used up by everyone. Players get the realistic 3D Earth by adding their
// OWN free Cesium token in Settings.
//
// Never put a Google Maps API key here: Google bills the key's owner for usage.
export const PUBLIC_ION_TOKEN = '';
