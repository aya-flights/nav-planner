import type { Speeds } from './flight';

export interface Waypoint {
  name: string;
  lat: number;
  lon: number;
  altFt: number; // MSL
  groundFt?: number; // terrain under a clicked waypoint, for the low-altitude warning
}

// ponytail: approximate field coordinates/elevations — fine for sightseeing, not for navigation.
export const AIRPORTS: Waypoint[] = [
  { name: 'LLHZ Herzliya', lat: 32.1806, lon: 34.8347, altFt: 30 },
  { name: 'LLHA Haifa', lat: 32.8094, lon: 35.0431, altFt: 30 },
  { name: 'LLBG Ben Gurion', lat: 32.0114, lon: 34.8867, altFt: 135 },
  { name: 'LLMG Megiddo', lat: 32.5973, lon: 35.2288, altFt: 200 },
  { name: 'LLIB Rosh Pina', lat: 32.981, lon: 35.5719, altFt: 922 },
  { name: 'LLBS Beersheba', lat: 31.287, lon: 34.7228, altFt: 656 },
  { name: 'LLEY Ein Yahav', lat: 30.6217, lon: 35.2033, altFt: -164 },
  { name: 'LLER Ramon', lat: 29.7237, lon: 35.0115, altFt: 288 },
];

const DEFAULT_ROUTE: Waypoint[] = [
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
    return {
      name: String(w.name ?? `WP${i + 1}`).slice(0, 40),
      lat, lon, altFt,
      groundFt: Number.isFinite(groundFt) ? groundFt : undefined,
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
    return { name, lat: w?.lat, lon: w?.lng ?? w?.lon, altFt };
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
