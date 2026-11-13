// Game data: drones, job types, landmarks. (Pickup and drop-off places are real ones from OpenStreetMap: see places.js.)

export const DRONES = [
  {
    id: 'sparrow', name: 'Sparrow Mini', price: 0,
    maxSpeed: 14, vSpeed: 6, accel: 5, battery: 240, cargo: 1, arms: 4,
    color: '#e8eef7', accent: '#ff7a1a', scale: 2.0,
    blurb: 'Your first drone. Small and friendly.',
  },
  {
    id: 'courier', name: 'Courier X1', price: 400,
    maxSpeed: 20, vSpeed: 8, accel: 6, battery: 330, cargo: 2.5, arms: 4,
    color: '#6ec6ff', accent: '#ffffff', scale: 2.1,
    blurb: 'Faster, and it can carry parcels.',
  },
  {
    id: 'falcon', name: 'Falcon Quad', price: 1500,
    maxSpeed: 28, vSpeed: 10, accel: 8, battery: 450, cargo: 5, arms: 4,
    color: '#3ddc97', accent: '#10261c', scale: 2.3,
    blurb: 'A real speed machine for medical rushes.',
  },
  {
    id: 'hawk', name: 'Hawk Hex', price: 5000,
    maxSpeed: 38, vSpeed: 13, accel: 10, battery: 650, cargo: 9, arms: 6,
    color: '#ffd23f', accent: '#2b2b2b', scale: 2.5,
    blurb: 'Six rotors. Heavy loads, long trips.',
  },
  {
    id: 'eagle', name: 'Eagle Octo', price: 14000,
    maxSpeed: 50, vSpeed: 16, accel: 12, battery: 900, cargo: 16, arms: 8,
    color: '#ff5d73', accent: '#ffffff', scale: 2.8,
    blurb: 'Eight rotors. Hauls big freight across town.',
  },
  {
    id: 'phoenix', name: 'Phoenix Elite', price: 40000,
    maxSpeed: 70, vSpeed: 22, accel: 16, battery: 1300, cargo: 28, arms: 8,
    color: '#b57bff', accent: '#ffe066', scale: 3.0,
    blurb: 'The best drone in the world.',
  },
];

// Rough distance (m) a drone can fly on one battery.
export function droneRange(d) {
  return 0.565 * d.maxSpeed * d.battery;
}

export const JOB_TYPES = [
  {
    id: 'food', name: 'Food Delivery', icon: '🍔', color: '#ff8a3d',
    cargo: [0.4, 1.0], dist: [0.18, 0.4], maxDist: 3000, minDist: 300,
    rate: 0.085, base: 25, speedMul: 0.6,
    pickupNoun: 'food',
  },
  {
    id: 'parcel', name: 'Parcels', icon: '📦', color: '#c8a26b',
    cargo: [1.5, 5], dist: [0.25, 0.5], maxDist: 6000, minDist: 500,
    rate: 0.11, base: 60, speedMul: 0.6,
    pickupNoun: 'parcel',
  },
  {
    id: 'medical', name: 'Medical Rush', icon: '💊', color: '#ff4f6d',
    cargo: [0.5, 4], dist: [0.3, 0.55], maxDist: 9000, minDist: 800,
    rate: 0.22, base: 120, speedMul: 0.78,
    pickupNoun: 'medicine',
  },
  {
    id: 'freight', name: 'Heavy Freight', icon: '🏗️', color: '#6aa6ff',
    cargo: [8, 26], dist: [0.3, 0.55], maxDist: 12000, minDist: 1500,
    rate: 0.2, base: 300, speedMul: 0.6,
    pickupNoun: 'freight',
  },
];

export const LANDMARKS = [
  { name: 'Eiffel Tower', place: 'Paris, France', lat: 48.8584, lon: 2.2945 },
  { name: 'Statue of Liberty', place: 'New York, USA', lat: 40.6892, lon: -74.0445 },
  { name: 'Sydney Opera House', place: 'Sydney, Australia', lat: -33.8568, lon: 151.2153 },
  { name: 'Big Ben', place: 'London, UK', lat: 51.5007, lon: -0.1246 },
  { name: 'Colosseum', place: 'Rome, Italy', lat: 41.8902, lon: 12.4922 },
  { name: 'Burj Khalifa', place: 'Dubai, UAE', lat: 25.1972, lon: 55.2744 },
  { name: 'Golden Gate Bridge', place: 'San Francisco, USA', lat: 37.8199, lon: -122.4783 },
  { name: 'Tokyo Tower', place: 'Tokyo, Japan', lat: 35.6586, lon: 139.7454 },
  { name: 'Christ the Redeemer', place: 'Rio de Janeiro, Brazil', lat: -22.9519, lon: -43.2105 },
  { name: 'Times Square', place: 'New York, USA', lat: 40.758, lon: -73.9855 },
  { name: 'Great Pyramid', place: 'Giza, Egypt', lat: 29.9792, lon: 31.1342 },
  { name: 'Taj Mahal', place: 'Agra, India', lat: 27.1751, lon: 78.0421 },
];

// Address of the public multiplayer relay (ws://host:port or wss://host). Empty = multiplayer off
// until a player types a server address in Settings.
export const DEFAULT_SERVER = '';

export const DEFAULT_SAVE = {
  version: 1,
  money: 0,
  owned: ['sparrow'],
  drone: 'sparrow',
  lat: LANDMARKS[0].lat,
  lon: LANDMARKS[0].lon,
  placeName: LANDMARKS[0].name,
  stats: { jobs: 0, earned: 0, km: 0 },
  settings: { quality: 'high', volume: 0.5, collisions: true, units: 'kmh', rumble: true, mapSource: 'auto', playerName: '', mpUrl: DEFAULT_SERVER },
};
