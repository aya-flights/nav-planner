import type { Speeds, Wind } from './flight';

export interface Waypoint {
  name: string;
  lat: number;
  lon: number;
  altFt: number; // MSL
  groundFt?: number; // terrain under a clicked waypoint, for the low-altitude warning
  runways?: number[]; // true runway headings (deg) for final approach alignment
}

/** Israel AIP aerodrome reference points (WGS84), field elevations (ft MSL), and runway true headings. */
export const AIRPORTS: Waypoint[] = [
  { name: 'LLHZ Herzliya', lat: 32.1794, lon: 34.8344, altFt: 121, runways: [104, 284] },
  { name: 'LLHA Haifa', lat: 32.8083, lon: 35.0428, altFt: 28, runways: [160, 340] },
  { name: 'LLBG Ben Gurion', lat: 32.0094, lon: 34.8856, altFt: 135, runways: [80, 260, 121, 301, 29, 209] },
  { name: 'LLMG Megiddo', lat: 32.5972, lon: 35.2347, altFt: 200, runways: [91, 271] },
  { name: 'LLIB Rosh Pina', lat: 32.9808, lon: 35.5719, altFt: 884, runways: [150, 330] },
  { name: 'LLBS Beersheba', lat: 31.2869, lon: 34.7228, altFt: 656, runways: [139, 319] },
  { name: 'LLEY Ein Yahav', lat: 30.6217, lon: 35.2031, altFt: -164, runways: [11, 191] },
  { name: 'LLER Ramon', lat: 29.7272, lon: 35.0142, altFt: 288, runways: [14, 194] },
];

export const DEFAULT_ROUTE: Waypoint[] = [
  AIRPORTS[0],
  { name: 'Netanya', lat: 32.33, lon: 34.845, altFt: 1500 },
  { name: 'Caesarea', lat: 32.5, lon: 34.89, altFt: 1500 },
  AIRPORTS[1],
];

const KEY = 'c172-route';

/** Validates untrusted JSON (file import / localStorage) into waypoints. */
export function parseRoute(text: string): Waypoint[] {
  const arr = JSON.parse(text);
  if (!Array.isArray(arr)) throw new Error('Route file must be a JSON array of waypoints');
  return arr.map((w, i) => {
    const lat = Number(w?.lat), lon = Number(w?.lon), altFt = Number(w?.altFt), groundFt = Number(w?.groundFt);
    if (![lat, lon, altFt].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
      throw new Error(`Waypoint ${i + 1} needs numeric lat, lon, altFt`);
    const runways = Array.isArray(w?.runways)
      ? w.runways.map(Number).filter((h: number) => Number.isFinite(h) && h >= 0 && h <= 360)
      : undefined;
    return {
      name: String(w.name ?? `WP${i + 1}`).slice(0, 40),
      lat, lon, altFt,
      groundFt: Number.isFinite(groundFt) ? groundFt : undefined,
      runways: runways?.length ? runways : undefined,
    };
  });
}

/**
 * Reads a route file: either this app's own export (an array of waypoints) or a navigation-plan file
 * ({ waypoints: [{ lat, lng, name }], legAltitudes, defaultAltitude, cruiseSpeed }).
 * In a plan, leg n runs from waypoint n to n+1 (1-based, like its "n_n+1" leg keys) and each waypoint
 * takes the altitude of the leg leading to it; a known departure/arrival airport sits at field elevation.
 */
export function parseRouteFile(text: string): { waypoints: Waypoint[]; cruiseKt?: number } {
  const data = JSON.parse(text);
  if (Array.isArray(data)) return { waypoints: parseRoute(text) };
  if (!Array.isArray(data?.waypoints) || data.waypoints.length < 2)
    throw new Error('Expected a "waypoints" list with at least 2 points');
  const num = (v: unknown) => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const fallback = num(data.defaultAltitude), def = Number.isFinite(fallback) ? fallback : 1500;
  const legAlt = (leg: number) => {
    const v = num(data.legAltitudes?.[leg]);
    return Number.isFinite(v) ? v : def;
  };
  const last = data.waypoints.length - 1;
  const waypoints = data.waypoints.map((w: any, i: number) => {
    const name = String(w?.name ?? `WP${i + 1}`);
    const airport = AIRPORTS.find((a) => a.name.split(' ')[0] === name.trim().toUpperCase());
    const altFt = (i === 0 || i === last) && airport ? airport.altFt : i === 0 ? def : legAlt(i);
    return { name, lat: w?.lat, lon: w?.lng ?? w?.lon, altFt, runways: airport?.runways };
  });
  const cruise = num(data.cruiseSpeed);
  return { waypoints: parseRoute(JSON.stringify(waypoints)), cruiseKt: Number.isFinite(cruise) ? cruise : undefined };
}

export function loadRoute(): Waypoint[] {
  try {
    const s = localStorage.getItem(KEY);
    return s ? parseRoute(s) : DEFAULT_ROUTE;
  } catch {
    return DEFAULT_ROUTE;
  }
}

export const saveRoute = (wps: Waypoint[]) => localStorage.setItem(KEY, JSON.stringify(wps));

const SPEEDS_KEY = 'c172-speeds';
// Sensible C172 limits: cruise between slow flight and max cruise, climb between Vx-ish and cruise-climb.
export const CRUISE_RANGE = [60, 125] as const, CLIMB_RANGE = [55, 90] as const;
const clampKt = (v: unknown, [lo, hi]: readonly [number, number], fallback: number) =>
  v !== "" && v != null && Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : fallback;

export function loadSpeeds(defaults: Speeds): Speeds {
  try {
    const s = JSON.parse(localStorage.getItem(SPEEDS_KEY) ?? '{}');
    return { cruiseKt: clampKt(s.cruiseKt, CRUISE_RANGE, defaults.cruiseKt), climbKt: clampKt(s.climbKt, CLIMB_RANGE, defaults.climbKt) };
  } catch {
    return defaults;
  }
}

export function setSpeed(current: Speeds, key: keyof Speeds, value: string): Speeds {
  const next = { ...current, [key]: clampKt(value, key === 'cruiseKt' ? CRUISE_RANGE : CLIMB_RANGE, current[key]) };
  localStorage.setItem(SPEEDS_KEY, JSON.stringify(next));
  return next;
}

const WIND_KEY = 'c172-wind';
export const WIND_KT_RANGE = [0, 50] as const;

export function loadWind(defaults: Wind): Wind {
  try {
    const w = JSON.parse(localStorage.getItem(WIND_KEY) ?? '{}');
    const dir = Number(w.dirDeg);
    return {
      dirDeg: Number.isFinite(dir) ? ((Math.round(dir) % 360) + 360) % 360 : defaults.dirDeg,
      kt: clampKt(w.kt, WIND_KT_RANGE, defaults.kt),
    };
  } catch {
    return defaults;
  }
}

export function setWind(current: Wind, key: keyof Wind, value: string): Wind {
  const n = Number(value);
  const next = key === 'dirDeg'
    ? { ...current, dirDeg: value !== '' && Number.isFinite(n) ? ((Math.round(n) % 360) + 360) % 360 : current.dirDeg }
    : { ...current, kt: clampKt(value, WIND_KT_RANGE, current.kt) };
  localStorage.setItem(WIND_KEY, JSON.stringify(next));
  return next;
}
