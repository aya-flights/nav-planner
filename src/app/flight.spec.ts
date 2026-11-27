import { AIRPORTS } from './route';
import { buildTrajectory, describeApproach, describeLegs, distanceM, sampleAt } from './flight';

describe('buildTrajectory', () => {
  const a = { name: 'A', lat: 32.0, lon: 34.8, altFt: 1000 };
  const b = { name: 'B', lat: 32.5, lon: 34.8, altFt: 1000 };

  it('flies a straight northbound leg at cruise speed', () => {
    const traj = buildTrajectory([a, b], { cruiseKt: 110, climbKt: 74 });
    const expected = distanceM(a.lat, a.lon, b.lat, b.lon) / (110 * 0.514444);
    expect(Math.abs(traj.at(-1)!.t - expected)).toBeLessThan(10);
    expect(traj.every((s) => Math.abs(s.roll) < 0.1 && (s.heading < 1 || s.heading > 359))).toBe(true);
    expect(traj.every((s) => Math.abs(s.pitch) < 0.01)).toBe(true); // straight and level: wings on the horizon
    expect(traj[0].gsKt).toBeCloseTo(110, 1);
  });

  it('banks right for a right turn, then climbs and lands on a final low waypoint', () => {
    const c = { name: 'C', lat: 32.5, lon: 35.3, altFt: 3000 };
    const d = { name: 'D', lat: 32.5, lon: 35.6, altFt: 100 };
    const traj = buildTrajectory([a, b, c, d]);
    expect(Math.max(...traj.map((s) => s.roll))).toBeGreaterThan(15);
    expect(Math.max(...traj.map((s) => s.altFt))).toBeCloseTo(3000, -1);
    expect(traj.at(-1)!.altFt).toBeLessThan(200);
  });

  it('crabs into a crosswind and adjusts groundspeed for headwind/tailwind', () => {
    // Flying North (000) at 100 kt with a 20 kt wind from 090 (East) -> must crab East (~11.5 deg), GS ~98 kt
    const traj = buildTrajectory([a, b], { cruiseKt: 100, climbKt: 74 }, { dirDeg: 90, kt: 20 });
    const mid = sampleAt(traj, traj.at(-1)!.t / 2);
    expect(mid.heading).toBeGreaterThan(10);
    expect(mid.heading).toBeLessThan(13);
    expect(mid.gsKt).toBeCloseTo(Math.sqrt(100 * 100 - 20 * 20), 0);
    // Still arrives near B's longitude
    expect(traj.at(-1)!.lon).toBeCloseTo(b.lon, 2);
  });

  it('aligns final approach with the favored runway and descends on a stabilized glideslope', () => {
    const haifa = AIRPORTS[1]; // LLHA: runways [160, 340], altFt 28
    const start = { name: 'Caesarea', lat: 32.5, lon: 34.89, altFt: 1500 };
    // Wind from 160 favors Runway 16 (160 deg) even though approaching from the south
    const traj = buildTrajectory([start, haifa], { cruiseKt: 90, climbKt: 74 }, { dirDeg: 160, kt: 10 });
    const end = traj.at(-1)!;
    expect(end.heading).toBeGreaterThan(150);
    expect(end.heading).toBeLessThan(170);
    expect(end.altFt).toBeCloseTo(haifa.altFt, -1);
    expect(end.next).toBe(1); // maps synthetic approach fixes back to destination waypoint index
  });
});

describe('describeLegs & describeApproach', () => {
  it('computes leg course, distance, and wind-adjusted ETE', () => {
    const a = { name: 'A', lat: 32.0, lon: 34.8, altFt: 1000 };
    const b = { name: 'B', lat: 32.5, lon: 34.8, altFt: 1000 };
    const [calm] = describeLegs([a, b], { cruiseKt: 100, climbKt: 74 }, { dirDeg: 0, kt: 0 });
    const [headwind] = describeLegs([a, b], { cruiseKt: 100, climbKt: 74 }, { dirDeg: 0, kt: 20 });
    expect(calm.courseDeg).toBe(360);
    expect(calm.distanceNm).toBeCloseTo(30, 0);
    expect(headwind.eteSec).toBeGreaterThan(calm.eteSec);
  });

  it('describes favored runway and FAF altitude for airport destinations', () => {
    const start = { name: 'Caesarea', lat: 32.5, lon: 34.89, altFt: 1500 };
    const info = describeApproach([start, AIRPORTS[1]], { dirDeg: 160, kt: 10 });
    expect(info).not.toBeNull();
    expect(info!.runwayLabel).toBe('16');
    expect(info!.fafAltFt).toBeGreaterThan(900);
  });
});
