import { buildTrajectory, distanceM } from './flight';

describe('buildTrajectory', () => {
  const a = { name: 'A', lat: 32.0, lon: 34.8, altFt: 1000 };
  const b = { name: 'B', lat: 32.5, lon: 34.8, altFt: 1000 };

  it('flies a straight northbound leg at cruise speed', () => {
    const traj = buildTrajectory([a, b], { cruiseKt: 110, climbKt: 74 });
    const expected = distanceM(a.lat, a.lon, b.lat, b.lon) / (110 * 0.514444);
    expect(Math.abs(traj.at(-1)!.t - expected)).toBeLessThan(10);
    expect(traj.every((s) => Math.abs(s.roll) < 0.1 && (s.heading < 1 || s.heading > 359))).toBe(true);
    expect(traj.every((s) => Math.abs(s.pitch) < 0.01)).toBe(true); // straight and level: wings on the horizon
  });

  it('banks right for a right turn, then climbs and lands on a final low waypoint', () => {
    const c = { name: 'C', lat: 32.5, lon: 35.3, altFt: 3000 };
    const d = { name: 'D', lat: 32.5, lon: 35.6, altFt: 100 };
    const traj = buildTrajectory([a, b, c, d]);
    expect(Math.max(...traj.map((s) => s.roll))).toBeGreaterThan(15);
    expect(Math.max(...traj.map((s) => s.altFt))).toBeCloseTo(3000, -1);
    expect(traj.at(-1)!.altFt).toBeLessThan(200);
  });
});
