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
  gsKt: number;
  vsFpm: number;
  turnRate: number; // deg/s, right +
  next: number; // index of waypoint being flown to
}

export const STEP = 0.5; // s between trajectory samples
const R = 6371000, D = Math.PI / 180, KT = 0.514444, FT = 3.28084, G = 9.81;
// Cessna 172 autopilot profile
export interface Speeds { cruiseKt: number; climbKt: number; }
/** C172S defaults: 90 kt cruise, climb at Vy = 74 KIAS. */
export const DEFAULT_SPEEDS: Speeds = { cruiseKt: 90, climbKt: 74 };
export interface Wind { dirDeg: number; kt: number; }
export const DEFAULT_WIND: Wind = { dirDeg: 0, kt: 0 };
const MAX_DESCENT_KT = 90;
const CLIMB_FPM = 700, DESC_FPM = 500, MAX_BANK = 20, ROLL_RATE = 10, ACCEL = 1.5, VS_RATE = 200;
const GLIDE_ANGLE_RAD = 3 * D;
const FINAL_APPROACH_M = 3 * 1852;

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

interface SimWaypoint {
  lat: number;
  lon: number;
  altFt: number;
  origNext: number;
  glideslope?: boolean;
}

function groundVelocity(kias: number, heading: number, wind: Wind) {
  const va = kias * KT, w = wind.kt * KT;
  const vn = va * Math.cos(heading * D) - w * Math.cos(wind.dirDeg * D);
  const ve = va * Math.sin(heading * D) - w * Math.sin(wind.dirDeg * D);
  const gsMps = Math.max(1, Math.hypot(vn, ve));
  return { gsMps, gsKt: gsMps / KT, track: (Math.atan2(ve, vn) / D + 360) % 360 };
}

function crabHeading(desiredTrack: number, kias: number, wind: Wind): number {
  if (wind.kt <= 0) return desiredTrack;
  const sinWca = Math.max(-0.95, Math.min(0.95, (wind.kt / Math.max(1, kias)) * Math.sin((wind.dirDeg - desiredTrack) * D)));
  return (desiredTrack + Math.asin(sinWca) / D + 360) % 360;
}

function crossTrackErrorM(lat1: number, lon1: number, legBearing: number, lat: number, lon: number): number {
  const d13 = distanceM(lat1, lon1, lat, lon) / R;
  const b13 = bearing(lat1, lon1, lat, lon) * D;
  return Math.asin(Math.max(-1, Math.min(1, Math.sin(d13) * Math.sin(b13 - legBearing * D)))) * R;
}

function pickRunway(runways: number[], inboundBearing: number, wind: Wind): number {
  if (wind.kt >= 3) {
    return runways.reduce((best, r) =>
      Math.cos((wind.dirDeg - r) * D) > Math.cos((wind.dirDeg - best) * D) ? r : best
    );
  }
  return runways.reduce((best, r) =>
    Math.abs(wrap180(r - inboundBearing)) < Math.abs(wrap180(best - inboundBearing)) ? r : best
  );
}

export interface LegSummary {
  distanceNm: number;
  courseDeg: number;
  eteSec: number;
}

export interface ApproachInfo {
  runwayHdg: number;
  runwayLabel: string;
  fafAltFt: number;
}

function selectApproach(wps: Waypoint[], wind: Wind) {
  if (wps.length < 2) return null;
  const dest = wps[wps.length - 1], prev = wps[wps.length - 2];
  if (!dest.runways?.length) return null;
  const legLen = distanceM(prev.lat, prev.lon, dest.lat, dest.lon);
  if (legLen < 1200) return null;
  const inbound = bearing(prev.lat, prev.lon, dest.lat, dest.lon);
  const rwyHdg = pickRunway(dest.runways, inbound, wind);
  const finalDist = Math.min(FINAL_APPROACH_M, legLen * 0.45);
  const fafAltFt = Math.round(dest.altFt + finalDist * Math.tan(GLIDE_ANGLE_RAD) * FT);
  return { dest, prev, legLen, rwyHdg, finalDist, fafAltFt };
}

/** Returns runway alignment and glideslope details when the destination has runway headings. */
export function describeApproach(wps: Waypoint[], wind: Wind = DEFAULT_WIND): ApproachInfo | null {
  const sel = selectApproach(wps, wind);
  if (!sel) return null;
  const num = Math.round(sel.rwyHdg / 10) || 36;
  return {
    runwayHdg: Math.round(sel.rwyHdg),
    runwayLabel: String(num).padStart(2, '0'),
    fafAltFt: sel.fafAltFt,
  };
}

/** Computes per-leg distance (NM), true course (deg), and wind-adjusted ETE (s). */
export function describeLegs(
  wps: Waypoint[],
  { cruiseKt, climbKt }: Speeds = DEFAULT_SPEEDS,
  wind: Wind = DEFAULT_WIND,
): LegSummary[] {
  return wps.slice(1).map((wp, i) => {
    const prev = wps[i];
    const distM = distanceM(prev.lat, prev.lon, wp.lat, wp.lon);
    const courseDeg = bearing(prev.lat, prev.lon, wp.lat, wp.lon);
    const kias = wp.altFt - prev.altFt > 100 ? climbKt : cruiseKt;
    const { gsMps } = groundVelocity(kias, crabHeading(courseDeg, kias, wind), wind);
    return {
      distanceNm: distM / 1852,
      courseDeg: Math.round(courseDeg) % 360 || 360,
      eteSec: distM / gsMps,
    };
  });
}

function expandWithApproach(wps: Waypoint[], wind: Wind): SimWaypoint[] {
  const nodes: SimWaypoint[] = wps.map((w, i) => ({ lat: w.lat, lon: w.lon, altFt: w.altFt, origNext: i }));
  const sel = selectApproach(wps, wind);
  if (!sel) return nodes;

  const { dest, prev, legLen, rwyHdg, finalDist, fafAltFt } = sel;
  const lastIdx = wps.length - 1;
  const recip = (rwyHdg + 180) % 360;
  const [fafLat, fafLon] = destination(dest.lat, dest.lon, recip, finalDist);

  const extra: SimWaypoint[] = [];
  const turnOntoFinal = Math.abs(wrap180(rwyHdg - bearing(prev.lat, prev.lon, fafLat, fafLon)));
  if (turnOntoFinal > 60) {
    const side = wrap180(bearing(dest.lat, dest.lon, prev.lat, prev.lon) - recip) >= 0 ? 1 : -1;
    const iafDist = Math.min(2.5 * 1852, legLen * 0.35);
    const [iafLat, iafLon] = destination(fafLat, fafLon, (recip + side * 55 + 360) % 360, iafDist);
    const iafAltFt = Math.max(fafAltFt, Math.min(prev.altFt, fafAltFt + 400));
    extra.push({ lat: iafLat, lon: iafLon, altFt: iafAltFt, origNext: lastIdx });
  }
  extra.push({ lat: fafLat, lon: fafLon, altFt: fafAltFt, origNext: lastIdx });
  nodes.splice(lastIdx, 1, ...extra, { ...nodes[lastIdx], glideslope: true });
  return nodes;
}

/**
 * Simulates an autopilot flying the route: great-circle track guidance with turn anticipation,
 * wind correction (crabbing), early climbs at Vy, ~3° descents, and runway-aligned final approaches.
 */
export function buildTrajectory(
  wps: Waypoint[],
  { cruiseKt: CRUISE, climbKt: CLIMB }: Speeds = DEFAULT_SPEEDS,
  wind: Wind = DEFAULT_WIND,
): FlightState[] {
  const DESCENT = Math.min(MAX_DESCENT_KT, CRUISE);
  const out: FlightState[] = [];
  if (wps.length < 2) return out;
  const nodes = expandWithApproach(wps, wind);
  let { lat, lon, altFt } = nodes[0];
  let idx = 1, roll = 0, vsFpm = 0;
  let kias = nodes[1].altFt > altFt ? CLIMB : CRUISE;
  let heading = crabHeading(bearing(lat, lon, nodes[1].lat, nodes[1].lon), kias, wind);

  for (let t = 0; t < 8 * 3600; t += STEP) {
    let { gsMps, gsKt, track } = groundVelocity(kias, heading, wind);
    let prev = nodes[idx - 1], wp = nodes[idx];
    let dist = distanceM(lat, lon, wp.lat, wp.lon);
    let direct = bearing(lat, lon, wp.lat, wp.lon);
    let err = wrap180(direct - track);

    for (;;) {
      const last = idx === nodes.length - 1;
      let passed: boolean;
      if (last) {
        passed = dist < 60 || (dist < 400 && Math.abs(err) > 90);
      } else {
        const legBearing = bearing(prev.lat, prev.lon, wp.lat, wp.lon);
        const nextBearing = bearing(wp.lat, wp.lon, nodes[idx + 1].lat, nodes[idx + 1].lon);
        const turnAngle = Math.abs(wrap180(nextBearing - legBearing));
        const turnRad = (gsMps * gsMps) / (G * Math.tan(MAX_BANK * D));
        const maxLead = Math.min(distanceM(prev.lat, prev.lon, wp.lat, wp.lon), distanceM(wp.lat, wp.lon, nodes[idx + 1].lat, nodes[idx + 1].lon)) * 0.4;
        const lead = Math.min(maxLead, Math.max(250, turnRad * Math.tan((Math.min(130, turnAngle) * D) / 2)));
        passed = dist <= lead || (dist < 1500 && Math.abs(err) > 90);
      }
      if (!passed) break;
      if (last) return out;
      prev = wp;
      wp = nodes[++idx];
      dist = distanceM(lat, lon, wp.lat, wp.lon);
      direct = bearing(lat, lon, wp.lat, wp.lon);
      err = wrap180(direct - track);
    }

    const legBearing = bearing(prev.lat, prev.lon, wp.lat, wp.lon);
    const legLen = distanceM(prev.lat, prev.lon, wp.lat, wp.lon);
    let desiredTrack = direct;
    if (legLen >= 300 && dist >= 600 && Math.abs(wrap180(direct - legBearing)) <= 75) {
      const xte = crossTrackErrorM(prev.lat, prev.lon, legBearing, lat, lon);
      const intercept = Math.max(-45, Math.min(45, -xte * 0.04));
      desiredTrack = (legBearing + intercept + 360) % 360;
    }

    const dAlt = wp.altFt - altFt;
    let targetVs = 0; // proportional capture (10 fpm per ft) levels off smoothly
    if (dAlt > 1) targetVs = Math.min(CLIMB_FPM, dAlt * 10);
    else if (wp.glideslope && dAlt < -1) {
      const reqVs = (dAlt / Math.max(1, (dist - 60) / gsMps)) * 60;
      targetVs = Math.max(-DESC_FPM, Math.min(0, reqVs));
    } else if (dAlt < -1 && dist <= (-dAlt / DESC_FPM) * 60 * gsMps) {
      targetVs = Math.max(-DESC_FPM, dAlt * 10);
    }
    vsFpm = toward(vsFpm, targetVs, VS_RATE * STEP);
    kias = toward(kias, targetVs > 0 ? CLIMB : targetVs < 0 ? DESCENT : CRUISE, ACCEL * STEP);

    const hdgErr = wrap180(crabHeading(desiredTrack, kias, wind) - heading);
    roll = toward(roll, Math.max(-MAX_BANK, Math.min(MAX_BANK, hdgErr * 1.2)), ROLL_RATE * STEP);

    const vAir = kias * KT;
    const turnRate = (G * Math.tan(roll * D)) / vAir / D;
    // Attitude = flight-path angle + angle of attack relative to cruise, so level cruise reads exactly 0°
    // (as with the attitude indicator's miniature airplane set for cruise); slower flight shows a little nose-up.
    const pitch = Math.atan((vsFpm * 0.00508) / vAir) / D + (CRUISE - kias) * 0.08;
    ({ gsMps, gsKt, track } = groundVelocity(kias, heading, wind));
    out.push({ t, lat, lon, altFt, heading, pitch, roll, kias, gsKt, vsFpm, turnRate, next: wp.origNext });

    heading = (heading + turnRate * STEP + 360) % 360;
    ({ gsMps, track } = groundVelocity(kias, heading, wind));
    [lat, lon] = destination(lat, lon, track, gsMps * STEP);
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
    gsKt: l(a.gsKt, b.gsKt), vsFpm: l(a.vsFpm, b.vsFpm), turnRate: l(a.turnRate, b.turnRate),
  };
}
