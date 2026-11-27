import type { Waypoint } from './route';

export interface FlightState {
  t: number; // s since start
  lat: number;
  lon: number;
  altFt: number;
  heading: number; // deg true
  pitch: number; // deg, nose up +
  roll: number; // deg, right wing down +
  kias: number;
  vsFpm: number;
  turnRate: number; // deg/s, right +
  next: number; // index of waypoint being flown to
}

export const STEP = 0.5; // s between trajectory samples
const R = 6371000, D = Math.PI / 180, KT = 0.514444, G = 9.81;
// Cessna 172 autopilot profile
export interface Speeds { cruiseKt: number; climbKt: number; }
/** C172S defaults: 90 kt cruise, climb at Vy = 74 KIAS. */
export const DEFAULT_SPEEDS: Speeds = { cruiseKt: 90, climbKt: 74 };
const MAX_DESCENT_KT = 90;
const CLIMB_FPM = 700, DESC_FPM = 500, MAX_BANK = 20, ROLL_RATE = 10, ACCEL = 1.5, VS_RATE = 200;

const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
const toward = (v: number, target: number, maxStep: number) =>
  v + Math.max(-maxStep, Math.min(maxStep, target - v));

export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number) {
  const a = Math.sin(((lat2 - lat1) * D) / 2) ** 2 +
    Math.cos(lat1 * D) * Math.cos(lat2 * D) * Math.sin(((lon2 - lon1) * D) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function bearing(lat1: number, lon1: number, lat2: number, lon2: number) {
  const y = Math.sin((lon2 - lon1) * D) * Math.cos(lat2 * D);
  const x = Math.cos(lat1 * D) * Math.sin(lat2 * D) -
    Math.sin(lat1 * D) * Math.cos(lat2 * D) * Math.cos((lon2 - lon1) * D);
  return (Math.atan2(y, x) / D + 360) % 360;
}

function destination(lat: number, lon: number, hdg: number, m: number): [number, number] {
  const d = m / R, la = lat * D, h = hdg * D;
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(h));
  const lo2 = lon * D + Math.atan2(Math.sin(h) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return [la2 / D, lo2 / D];
}

/**
 * Simulates an autopilot flying the route: coordinated banked turns toward each waypoint,
 * climbs early at Vy, descents late on a ~3° path, so a final airport waypoint becomes a landing.
 * ponytail: point-pursuit guidance, no wind, no runway alignment — add a proper approach when needed.
 */
export function buildTrajectory(wps: Waypoint[], { cruiseKt: CRUISE, climbKt: CLIMB }: Speeds = DEFAULT_SPEEDS): FlightState[] {
  const DESCENT = Math.min(MAX_DESCENT_KT, CRUISE);
  const out: FlightState[] = [];
  if (wps.length < 2) return out;
  let { lat, lon, altFt } = wps[0];
  let next = 1, roll = 0, vsFpm = 0;
  let heading = bearing(lat, lon, wps[1].lat, wps[1].lon);
  let kias = wps[1].altFt > altFt ? CLIMB : CRUISE;

  for (let t = 0; t < 8 * 3600; t += STEP) {
    let wp = wps[next], dist = distanceM(lat, lon, wp.lat, wp.lon);
    let err = wrap180(bearing(lat, lon, wp.lat, wp.lon) - heading);
    for (;;) {
      const last = next === wps.length - 1;
      const passed = dist < (last ? 60 : 400) || (dist < 1500 && Math.abs(err) > 90);
      if (!passed) break;
      if (last) return out;
      wp = wps[++next];
      dist = distanceM(lat, lon, wp.lat, wp.lon);
      err = wrap180(bearing(lat, lon, wp.lat, wp.lon) - heading);
    }

    const dAlt = wp.altFt - altFt;
    let targetVs = 0; // proportional capture (10 fpm per ft) levels off smoothly
    if (dAlt > 1) targetVs = Math.min(CLIMB_FPM, dAlt * 10);
    else if (dAlt < -1 && dist <= (-dAlt / DESC_FPM) * 60 * DESCENT * KT) targetVs = Math.max(-DESC_FPM, dAlt * 10);
    vsFpm = toward(vsFpm, targetVs, VS_RATE * STEP);
    kias = toward(kias, targetVs > 0 ? CLIMB : targetVs < 0 ? DESCENT : CRUISE, ACCEL * STEP);
    roll = toward(roll, Math.max(-MAX_BANK, Math.min(MAX_BANK, err * 1.2)), ROLL_RATE * STEP);

    const v = kias * KT;
    const turnRate = (G * Math.tan(roll * D)) / v / D;
    // Attitude = flight-path angle + angle of attack relative to cruise, so level cruise reads exactly 0°
    // (as with the attitude indicator's miniature airplane set for cruise); slower flight shows a little nose-up.
    const pitch = Math.atan((vsFpm * 0.00508) / v) / D + (CRUISE - kias) * 0.08;
    out.push({ t, lat, lon, altFt, heading, pitch, roll, kias, vsFpm, turnRate, next });

    heading = (heading + turnRate * STEP + 360) % 360;
    [lat, lon] = destination(lat, lon, heading, v * STEP);
    const newAlt = altFt + (vsFpm / 60) * STEP;
    altFt = Math.sign(wp.altFt - newAlt) !== Math.sign(dAlt) && Math.abs(dAlt) > 1 ? wp.altFt : newAlt;
  }
  return out;
}

/** Linear interpolation between samples, heading-wrap aware. */
export function sampleAt(traj: FlightState[], t: number): FlightState {
  const i = Math.max(0, Math.min(traj.length - 2, Math.floor(t / STEP)));
  const a = traj[i], b = traj[i + 1] ?? a;
  const f = Math.max(0, Math.min(1, (t - a.t) / STEP));
  const l = (x: number, y: number) => x + (y - x) * f;
  return {
    t, next: a.next,
    lat: l(a.lat, b.lat), lon: l(a.lon, b.lon), altFt: l(a.altFt, b.altFt),
    heading: (a.heading + wrap180(b.heading - a.heading) * f + 360) % 360,
    pitch: l(a.pitch, b.pitch), roll: l(a.roll, b.roll), kias: l(a.kias, b.kias),
    vsFpm: l(a.vsFpm, b.vsFpm), turnRate: l(a.turnRate, b.turnRate),
  };
}
