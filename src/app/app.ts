import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, computed, signal, viewChild } from '@angular/core';
import {
  Cartesian2, Cartesian3, Cartographic, Color, Entity, HeightReference, ImageryLayer, Ion, JulianDate, LabelStyle,
  Math as CMath, OpenStreetMapImageryProvider, PerspectiveFrustum, ScreenSpaceEventHandler,
  ScreenSpaceEventType, Terrain, VerticalOrigin, Viewer, createOsmBuildingsAsync,
} from 'cesium';
import { environment } from '../environments/environment';
import { CockpitPanel, NavInfo } from './cockpit-panel';
import { DEFAULT_SPEEDS, FlightState, Speeds, buildTrajectory, distanceM, sampleAt } from './flight';
import { AIRPORTS, CLIMB_RANGE, CRUISE_RANGE, Waypoint, loadRoute, loadSpeeds, parseRouteFile, saveRoute, setSpeed } from './route';

const FT = 3.28084;
// ponytail: constant geoid height for Israel (~17–21 m) to turn MSL into WGS84 ellipsoid heights.
const GEOID_M = 18;
const EYE_M = 1.5;
const WAYPOINT_LEAD_S = 80; // flight seconds before arrival that a waypoint appears
// Base look direction per view; front pitch is the pilot's sightline over the nose (tall pilot sees more terrain).
const VIEWS = { left: { yaw: -45, pitch: -15 }, front: { yaw: 0, pitch: -8 }, low: { yaw: 0, pitch: -8 }, right: { yaw: 45, pitch: -15 } };
export type View = keyof typeof VIEWS;

@Component({
  selector: 'app-root',
  imports: [CockpitPanel],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements AfterViewInit, OnDestroy {
  private globe = viewChild.required<ElementRef<HTMLDivElement>>('globe');
  private viewer!: Viewer;

  protected readonly hasToken = !!environment.cesiumToken;
  protected readonly airports = AIRPORTS;
  protected readonly rates = [1, 2, 4, 8, 16];
  protected readonly mode = signal<'plan' | 'fly'>('plan');
  protected readonly waypoints = signal<Waypoint[]>(loadRoute());
  protected readonly speeds = signal<Speeds>(loadSpeeds(DEFAULT_SPEEDS));
  protected readonly cruiseRange = CRUISE_RANGE;
  protected readonly climbRange = CLIMB_RANGE;
  protected readonly trajectory = computed(() => buildTrajectory(this.waypoints(), this.speeds()));
  protected readonly duration = computed(() => this.trajectory().at(-1)?.t ?? 0);
  protected readonly summary = computed(() => {
    const w = this.waypoints();
    const nm = w.slice(1).reduce((s, p, i) => s + distanceM(w[i].lat, w[i].lon, p.lat, p.lon), 0) / 1852;
    return `${nm.toFixed(1)} NM · ${this.fmt(this.duration())} flight time`;
  });

  protected readonly simT = signal(0);
  protected readonly playing = signal(false);
  protected readonly rate = signal(1);
  protected readonly state = signal<FlightState | null>(null);
  protected readonly terrainWarn = signal(false);
  protected readonly nav = computed<NavInfo>(() => {
    const s = this.state(), wp = s && this.waypoints()[s.next];
    if (!s || !wp) return { name: '-', distNm: 0, eteSec: 0 };
    const m = distanceM(s.lat, s.lon, wp.lat, wp.lon);
    return { name: wp.name, distNm: m / 1852, eteSec: m / (s.kias * 0.514444) };
  });

  private look = { yaw: 0, pitch: 0, dragging: false };
  protected readonly view = signal<View>('front');

  protected setView(v: View) {
    this.view.set(v);
    this.look = { ...this.look, yaw: 0, pitch: 0 };
  }
  private lastFrame = performance.now();
  private wpEntities: Entity[] = [];

  ngAfterViewInit() {
    if (this.hasToken) Ion.defaultAccessToken = environment.cesiumToken;
    const v = (this.viewer = new Viewer(this.globe().nativeElement, {
      terrain: this.hasToken ? Terrain.fromWorldTerrain() : undefined,
      baseLayer: this.hasToken ? undefined : new ImageryLayer(new OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/', maximumLevel: 19 })),
      baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
      navigationHelpButton: false, animation: false, timeline: false, fullscreenButton: false,
      infoBox: false, selectionIndicator: false,
    }));
    if (this.hasToken) createOsmBuildingsAsync().then((b) => v.scene.primitives.add(b));
    v.scene.globe.enableLighting = true;
    v.scene.globe.depthTestAgainstTerrain = true;
    v.clock.currentTime = JulianDate.fromDate(new Date(new Date().toDateString() + ' 12:00 GMT+0200'));

    const h = new ScreenSpaceEventHandler(v.scene.canvas);
    h.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => this.onClick(e.position), ScreenSpaceEventType.LEFT_CLICK);
    h.setInputAction(() => this.mode() === 'plan' && this.update(this.waypoints().slice(0, -1)), ScreenSpaceEventType.RIGHT_CLICK);
    h.setInputAction(() => (this.look.dragging = true), ScreenSpaceEventType.LEFT_DOWN);
    h.setInputAction(() => (this.look.dragging = false), ScreenSpaceEventType.LEFT_UP);
    h.setInputAction((e: ScreenSpaceEventHandler.MotionEvent) => {
      if (this.mode() !== 'fly' || !this.look.dragging) return;
      this.look.yaw = Math.max(-150, Math.min(150, this.look.yaw + (e.endPosition.x - e.startPosition.x) * 0.15));
      this.look.pitch = Math.max(-60, Math.min(60, this.look.pitch - (e.endPosition.y - e.startPosition.y) * 0.15));
    }, ScreenSpaceEventType.MOUSE_MOVE);

    v.scene.preRender.addEventListener(() => this.frame());
    this.draw();
    this.overview();
  }

  ngOnDestroy() {
    this.viewer?.destroy();
  }

  private onClick(pos: Cartesian2) {
    if (this.mode() !== 'plan') return;
    const ray = this.viewer.camera.getPickRay(pos);
    const p = ray && this.viewer.scene.globe.pick(ray, this.viewer.scene);
    if (!p) return;
    const c = Cartographic.fromCartesian(p);
    const groundFt = Math.round((c.height - GEOID_M) * FT);
    const w = this.waypoints();
    const altFt = Math.max(w.at(-1)?.altFt ?? 0, Math.ceil((groundFt + 1000) / 500) * 500);
    this.update([...w, {
      name: `WP${w.length + 1}`, lat: CMath.toDegrees(c.latitude), lon: CMath.toDegrees(c.longitude), altFt, groundFt,
    }]);
  }

  private frame() {
    const now = performance.now(), dt = Math.min(0.2, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (this.mode() !== 'fly') return;
    const traj = this.trajectory();
    if (this.playing()) {
      const t = Math.min(this.duration(), this.simT() + dt * this.rate());
      this.simT.set(t);
      if (t >= this.duration()) this.playing.set(false);
    }
    const s = sampleAt(traj, this.simT());
    this.state.set(s);
    const altM = s.altFt / FT + GEOID_M;
    const ground = this.viewer.scene.globe.getHeight(Cartographic.fromDegrees(s.lon, s.lat)) ?? -1000;
    this.terrainWarn.set(altM < ground - 15);
    // In flight, show only the waypoint being flown to, from 30 s before arrival until it's reached.
    const next = this.waypoints()[s.next];
    const showNext = !!next && distanceM(s.lat, s.lon, next.lat, next.lon) / (s.kias * 0.514444) <= WAYPOINT_LEAD_S;
    this.wpEntities.forEach((e, i) => {
      const show = i === s.next && showNext;
      if (e.show !== show) e.show = show;
    });
    // Looking sideways, aircraft roll shows up as view pitch and aircraft pitch as view roll.
    const yaw = VIEWS[this.view()].yaw + this.look.yaw, y = CMath.toRadians(yaw);
    this.viewer.camera.setView({
      destination: Cartesian3.fromDegrees(s.lon, s.lat, Math.max(altM, ground + 1) + EYE_M),
      orientation: {
        heading: CMath.toRadians(s.heading + yaw),
        pitch: CMath.toRadians(s.pitch * Math.cos(y) - s.roll * Math.sin(y) + VIEWS[this.view()].pitch + this.look.pitch),
        roll: CMath.toRadians(s.roll * Math.cos(y) + s.pitch * Math.sin(y)),
      },
    });
  }

  private draw() {
    const v = this.viewer;
    if (!v) return;
    v.entities.removeAll();
    const wps = this.waypoints();
    const pos = wps.map((w) => Cartesian3.fromDegrees(w.lon, w.lat)); // markers and track sit on the terrain
    this.wpEntities = wps.map((w, i) => v.entities.add({
      show: this.mode() === 'plan',
      position: pos[i],
      point: { heightReference: HeightReference.CLAMP_TO_GROUND, pixelSize: 10, color: Color.YELLOW, outlineColor: Color.BLACK, outlineWidth: 2, disableDepthTestDistance: Infinity },
      label: {
        heightReference: HeightReference.CLAMP_TO_GROUND,
        text: this.mode() === 'plan' ? `${w.name}\n${w.altFt} ft` : w.name, // altitude only while planning
        font: '13px sans-serif', style: LabelStyle.FILL_AND_OUTLINE,
        outlineWidth: 3, outlineColor: Color.BLACK, verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, -12), disableDepthTestDistance: Infinity,
      },
    }));
    if (pos.length > 1 && this.mode() === 'plan') { // route lines only while planning
      v.entities.add({ polyline: { positions: pos, width: 2, clampToGround: true, material: Color.YELLOW.withAlpha(0.5) } });
    }
  }

  private overview() {
    (this.viewer.camera.frustum as PerspectiveFrustum).fov = CMath.toRadians(60);
    if (this.waypoints().length > 1) this.viewer.zoomTo(this.viewer.entities);
    else this.viewer.camera.setView({ destination: Cartesian3.fromDegrees(35.0, 31.4, 550000) });
  }

  protected update(wps: Waypoint[]) {
    this.waypoints.set(wps);
    saveRoute(wps);
    this.draw();
  }

  protected edit(i: number, key: 'name' | 'altFt', value: string) {
    const wps = [...this.waypoints()];
    if (key === 'altFt') {
      const n = Number(value);
      if (!Number.isFinite(n)) return;
      wps[i] = { ...wps[i], altFt: Math.round(n) };
    } else wps[i] = { ...wps[i], name: value.slice(0, 40) };
    this.update(wps);
  }

  protected editSpeed(key: keyof Speeds, input: HTMLInputElement) {
    this.speeds.set(setSpeed(this.speeds(), key, input.value));
    input.value = String(this.speeds()[key]); // show the clamped value
  }

  protected remove(i: number) {
    this.update(this.waypoints().filter((_, j) => j !== i));
  }

  protected move(i: number, d: number) {
    const wps = [...this.waypoints()], j = i + d;
    if (j < 0 || j >= wps.length) return;
    [wps[i], wps[j]] = [wps[j], wps[i]];
    this.update(wps);
  }

  protected addAirport(sel: HTMLSelectElement) {
    const a = AIRPORTS[Number(sel.value)];
    sel.value = '';
    if (a) this.update([...this.waypoints(), a]);
  }

  protected isLow = (w: Waypoint) => w.groundFt !== undefined && w.altFt - w.groundFt < 1000;

  protected exportRoute() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(this.waypoints(), null, 2)], { type: 'application/json' }));
    a.download = 'route.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  protected async importRoute(input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const { waypoints, cruiseKt } = parseRouteFile(await file.text());
      this.update(waypoints);
      if (cruiseKt !== undefined) this.speeds.set(setSpeed(this.speeds(), 'cruiseKt', String(cruiseKt)));
      this.overview();
    } catch (e) {
      alert(`Could not import route: ${(e as Error).message}`);
    }
  }

  protected fly() {
    if (this.trajectory().length < 2) return;
    this.look = { yaw: 0, pitch: 0, dragging: false };
    this.view.set('front');
    this.simT.set(0);
    this.state.set(this.trajectory()[0]);
    this.viewer.scene.screenSpaceCameraController.enableInputs = false;
    (this.viewer.camera.frustum as PerspectiveFrustum).fov = CMath.toRadians(80);
    this.mode.set('fly');
    this.draw();
    this.playing.set(true);
  }

  protected plan() {
    this.playing.set(false);
    this.mode.set('plan');
    this.draw();
    this.viewer.scene.screenSpaceCameraController.enableInputs = true;
    this.overview();
  }

  protected seek(t: number) {
    this.simT.set(t);
  }

  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent) {
    if (this.mode() !== 'fly' || (e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === ' ') { e.preventDefault(); this.playing.update((p) => !p); }
    if (e.key === 'c' || e.key === 'C') this.setView('front');
    if (e.key === 'ArrowLeft') this.setView(this.view() === 'right' ? 'front' : 'left');
    if (e.key === 'ArrowRight') this.setView(this.view() === 'left' ? 'front' : 'right');
    if (e.key === 'Escape') this.plan();
    // Hold ↓ for the low cockpit view; ignore key auto-repeat so the look offset isn't reset every repeat.
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!e.repeat) this.setView('low'); }
  }

  @HostListener('document:keyup', ['$event'])
  onKeyUp(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' && this.mode() === 'fly' && this.view() === 'low') this.setView('front');
  }

  protected fmt(s: number) {
    const m = Math.floor(s / 60);
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }
}
