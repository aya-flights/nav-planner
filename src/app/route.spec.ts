import { parseRouteFile } from './route';

describe('parseRouteFile', () => {
  it('reads a navigation-plan file: leg altitudes, airport elevations, cruise speed', () => {
    const plan = {
      name: 'LLHZ-LLIB', cruiseSpeed: 90, defaultAltitude: 1500, legAltitudes: { '2': 2500 },
      waypoints: [
        { lat: 32.1787, lng: 34.8359, num: 1, name: 'LLHZ' },
        { lat: 32.2167, lng: 34.8823, num: 2, name: 'BAZRA' },
        { lat: 32.2557, lng: 34.8905, num: 3, name: 'DEROR' },
        { lat: 32.9802, lng: 35.5705, num: 4, name: 'LLIB' },
      ],
    };
    const { waypoints, cruiseKt } = parseRouteFile(JSON.stringify(plan));
    expect(waypoints.map((w) => [w.name, w.altFt])).toEqual([['LLHZ', 121], ['BAZRA', 1500], ['DEROR', 2500], ['LLIB', 884]]);
    expect(waypoints[0].runways).toEqual([104, 284]);
    expect(waypoints[3].runways).toEqual([150, 330]);
    expect(waypoints[1].lon).toBeCloseTo(34.8823);
    expect(cruiseKt).toBe(90);
  });

  it('still reads the app\'s own exported array', () => {
    const { waypoints, cruiseKt } = parseRouteFile('[{"name":"A","lat":32,"lon":35,"altFt":1000}]');
    expect(waypoints[0].altFt).toBe(1000);
    expect(cruiseKt).toBeUndefined();
  });

  it('rejects a plan with bad coordinates', () => {
    expect(() => parseRouteFile('{"waypoints":[{"lat":"x","lng":1},{"lat":1,"lng":1}]}')).toThrow();
  });
});
