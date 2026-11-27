import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, computed, signal, viewChild } from '@angular/core';
import {
  Cartesian2, Cartesian3, Cartographic, Color, Entity, HeightReference, ImageryLayer, Ion, JulianDate, LabelStyle,
  Math as CMath, OpenStreetMapImageryProvider, PerspectiveFrustum, ScreenSpaceEventHandler,
  ScreenSpaceEventType, Terrain, VerticalOrigin, Viewer, createOsmBuildingsAsync, sampleTerrainMostDetailed,
} from 'cesium';
import { egm96ToEllipsoid, ellipsoidToEgm96 } from 'egm96-universal';
import { environment } from '../environments/environment';
import { CockpitPanel, NavInfo } from './cockpit-panel';
import { MovingMap } from './moving-map';
import {
  DEFAULT_SPEEDS, DEFAULT_WIND, FlightState, Speeds, Wind,
  buildTrajectory, describeApproach, describeLegs, distanceM, sampleAt,
} from './flight';
import {
  AIRPORTS, CLIMB_RANGE, CRUISE_RANGE, DEFAULT_ROUTE, WIND_KT_RANGE, Waypoint,
  loadRoute, loadSpeeds, loadWind, parseRouteFile, saveRoute, setSpeed, setWind,
} from './route';

const FT = 3.28084;
const EYE_M = 1.5;
const WAYPOINT_LEAD_S = 80; // flight seconds before arrival that a waypoint appears
// Base look direction per view; front pitch is the pilot's sightline over the nose (tall pilot sees more terrain).
const VIEWS = { left: { yaw: -45, pitch: -15 }, front: { yaw: 0, pitch: -8 }, low: { yaw: 0, pitch: -8 }, right: { yaw: 45, pitch: -15 } };
export type View = keyof typeof VIEWS;

interface TerrainSample { distNm: number; groundFt: number; }
interface StatusMsg { text: string; kind: 'info' | 'error'; }

@Component({
  selector: 'app-root',
  imports: [CockpitPanel, MovingMap],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements AfterViewInit, OnDestroy {
  private globe = viewChild.required<ElementRef<HTMLDivElement>>('globe');
  private clearDialog = viewChild<ElementRef<HTMLDialogElement>>('clearDialog');
  private shortcutsPopover = viewChild<ElementRef<HTMLDivElement>>('shortcutsPopover');
  private viewer!: Viewer;

  protected readonly hasToken = !!environment.cesiumToken;
  protected readonly supportsPopover = typeof HTMLElement !== 'undefined' && Object.hasOwn(HTMLElement.prototype, 'popover');
  protected readonly shortcutsOpenFallback = signal(false);
  protected readonly airports = AIRPORTS;
  protected readonly rates = [1, 2, 4, 8, 16];
  protected readonly mode = signal<'plan' | 'fly'>('plan');
  protected readonly panelOpen = signal(true);
  protected readonly mapClickAdd = signal(true);
  protected readonly waypoints = signal<Waypoint[]>(loadRoute());
  private readonly history = signal<Waypoint[][]>([]);
  protected readonly canUndo = computed(() => this.history().length > 0);
  protected readonly status = signal<StatusMsg | null>(null);
  protected readonly speeds = signal<Speeds>(loadSpeeds(DEFAULT_SPEEDS));
  protected readonly wind = signal<Wind>(loadWind(DEFAULT_WIND));
  protected readonly cruiseRange = CRUISE_RANGE;
  protected readonly climbRange = CLIMB_RANGE;
  protected readonly windKtRange = WIND_KT_RANGE;
  protected readonly trajectory = computed(() => buildTrajectory(this.waypoints(), this.speeds(), this.wind()));
  protected readonly legs = computed(() => describeLegs(this.waypoints(), this.speeds(), this.wind()));
  protected readonly approach = computed(() => describeApproach(this.waypoints(), this.wind()));
  protected readonly duration = computed(() => this.trajectory().at(-1)?.t ?? 0);
  protected readonly totalNm = computed(() => {
    const w = this.waypoints();
    return w.slice(1).reduce((s, p, i) => s + distanceM(w[i].lat, w[i].lon, p.lat, p.lon), 0) / 1852;
  });
  protected readonly summary = computed(() => `${this.totalNm().toFixed(1)} NM · ${this.fmt(this.duration())} flight time`);

  private readonly terrainSamples = signal<TerrainSample[]>([]);
  protected readonly profileChart = computed(() => {
    const wps = this.waypoints();
    if (wps.length < 2) return null;
    const total = Math.max(0.1, this.totalNm());
    let cum = 0;
    const wpDists = wps.map((w, i) => {
      if (i > 0) cum += distanceM(wps[i - 1].lat, wps[i - 1].lon, w.lat, w.lon) / 1852;
      return { distNm: cum, altFt: w.altFt, groundFt: w.groundFt ?? 0 };
    });
    const samples = this.terrainSamples().length
      ? this.terrainSamples()
      : wpDists.map((p) => ({ distNm: p.distNm, groundFt: p.groundFt }));
    const minAlt = Math.min(0, ...wpDists.map((p) => p.altFt), ...samples.map((s) => s.groundFt));
    const maxAlt = Math.max(minAlt + 1500, ...wpDists.map((p) => p.altFt), ...samples.map((s) => s.groundFt)) + 200;
    const x = (d: number) => (d / total) * 300;
    const y = (a: number) => 64 - ((a - minAlt) / (maxAlt - minAlt)) * 58;
    const groundAt = (d: number) => {
      let best = samples[0];
      for (const s of samples) if (Math.abs(s.distNm - d) < Math.abs(best.distNm - d)) best = s;
      return best?.groundFt ?? 0;
    };
    const terrainPath = `M0 68 ${samples.map((s) => `L${x(s.distNm).toFixed(1)} ${y(s.groundFt).toFixed(1)}`).join(' ')} L300 68 Z`;
    const segments = wpDists.slice(1).map((p, i) => {
      const a = wpDists[i];
      const low = a.altFt - groundAt(a.distNm) < 1000 || p.altFt - groundAt(p.distNm) < 1000;
      return { x1: x(a.distNm), y1: y(a.altFt), x2: x(p.distNm), y2: y(p.altFt), low };
    });
    const dots = wpDists.map((p) => ({ cx: x(p.distNm), cy: y(p.altFt), low: p.altFt - groundAt(p.distNm) < 1000 }));
    return { terrainPath, segments, dots, minAlt: Math.round(minAlt), maxAlt: Math.round(maxAlt) };
  });

  protected readonly simT = signal(0);
  protected readonly playing = signal(false);
  protected readonly rate = signal(1);
  protected readonly state = signal<FlightState | null>(null);
  protected readonly aglFt = signal<number | null>(null);
  protected readonly terrainWarn = signal(false);
  protected readonly nav = computed<NavInfo>(() => {
    const s = this.state(), wp = s && this.waypoints()[s.next];
    if (!s || !wp) return { name: '-', distNm: 0, eteSec: 0 };
    const m = distanceM(s.lat, s.lon, wp.lat, wp.lon);
    return { name: wp.name, distNm: m / 1852, eteSec: m / (Math.max(1, s.gsKt) * 0.514444) };
  });

  private look = { yaw: 0, pitch: 0, dragging: false };
  protected readonly lookOffset = signal(false);
  protected readonly view = signal<View>('front');
  protected readonly windowView = signal<'terrain' | 'map'>('terrain');

  private prevViewBeforeMap: View = 'front';

  protected toggleWindowView() {
    if (this.windowView() === 'terrain') {
      this.prevViewBeforeMap = this.view();
      this.windowView.set('map');
      this.view.set('low');
    } else {
      this.windowView.set('terrain');
      this.view.set(this.prevViewBeforeMap || 'front');
    }
  }

  protected setView(v: View) {
    this.view.set(v);
    this.look = { ...this.look, yaw: 0, pitch: 0 };
    this.lookOffset.set(false);
  }
  private lastFrame = performance.now();
  private wpEntities: Entity[] = [];
  private dragWpIdx: number | null = null;
  private dragStartWps: Waypoint[] | null = null;
  private lastWpInteractMs = 0;
  private profileSeq = 0;

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
    h.setInputAction(() => {
      if (this.mode() === 'plan' && this.waypoints().length) {
        this.update(this.waypoints().slice(0, -1));
        this.notify('Removed last waypoint', 'info');
      }
    }, ScreenSpaceEventType.RIGHT_CLICK);
    h.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => this.onLeftDown(e.position), ScreenSpaceEventType.LEFT_DOWN);
    h.setInputAction(() => this.onLeftUp(), ScreenSpaceEventType.LEFT_UP);
    h.setInputAction((e: ScreenSpaceEventHandler.MotionEvent) => this.onMouseMove(e), ScreenSpaceEventType.MOUSE_MOVE);

    const dlg = this.clearDialog()?.nativeElement;
    if (dlg && !('closedBy' in HTMLDialogElement.prototype)) {
      let pressedOutside = false;
      const outside = (e: PointerEvent) => {
        const r = dlg.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      };
      dlg.addEventListener('pointerdown', (e) => { pressedOutside = outside(e); });
      dlg.addEventListener('pointerup', (e) => { if (pressedOutside && outside(e)) dlg.close(); });
    }

    v.scene.preRender.addEventListener(() => this.frame());
    this.draw();
    this.refreshTerrainProfile();
    this.overview();
  }

  ngOnDestroy() {
    this.viewer?.destroy();
  }

  private pickGround(pos: Cartesian2) {
    const ray = this.viewer.camera.getPickRay(pos);
    const p = ray && this.viewer.scene.globe.pick(ray, this.viewer.scene);
    if (!p) return null;
    const c = Cartographic.fromCartesian(p);
    const lat = CMath.toDegrees(c.latitude), lon = CMath.toDegrees(c.longitude);
    const groundFt = Math.round(ellipsoidToEgm96(lat, lon, c.height) * FT);
    return { lat, lon, groundFt };
  }

  private onLeftDown(pos: Cartesian2) {
    if (this.mode() === 'fly') {
      this.look.dragging = true;
      return;
    }
    const picked = this.viewer.scene.pick(pos);
    const idx = picked?.id ? this.wpEntities.indexOf(picked.id) : -1;
    if (idx >= 0) {
      this.dragWpIdx = idx;
      this.dragStartWps = this.waypoints();
      this.viewer.scene.screenSpaceCameraController.enableInputs = false;
    }
  }

  private onLeftUp() {
    if (this.mode() === 'fly') {
      this.look.dragging = false;
      return;
    }
    if (this.dragWpIdx !== null) {
      this.viewer.scene.screenSpaceCameraController.enableInputs = true;
      this.lastWpInteractMs = performance.now();
      if (this.dragStartWps && this.dragStartWps !== this.waypoints()) {
        this.pushHistory(this.dragStartWps);
        saveRoute(this.waypoints());
        this.refreshTerrainProfile();
      }
      this.dragWpIdx = null;
      this.dragStartWps = null;
    }
  }

  private onMouseMove(e: ScreenSpaceEventHandler.MotionEvent) {
    if (this.mode() === 'fly') {
      if (!this.look.dragging) return;
      this.look.yaw = Math.max(-150, Math.min(150, this.look.yaw + (e.endPosition.x - e.startPosition.x) * 0.15));
      this.look.pitch = Math.max(-60, Math.min(60, this.look.pitch - (e.endPosition.y - e.startPosition.y) * 0.15));
      this.lookOffset.set(Math.abs(this.look.yaw) > 0.5 || Math.abs(this.look.pitch) > 0.5);
      return;
    }
    if (this.dragWpIdx === null) return;
    const pt = this.pickGround(e.endPosition);
    if (!pt) return;
    const wps = [...this.waypoints()];
    wps[this.dragWpIdx] = { ...wps[this.dragWpIdx], lat: pt.lat, lon: pt.lon, groundFt: pt.groundFt };
    this.waypoints.set(wps);
    this.draw();
  }

  private onClick(pos: Cartesian2) {
    if (this.mode() !== 'plan' || !this.mapClickAdd() || performance.now() - this.lastWpInteractMs < 150) return;
    const picked = this.viewer.scene.pick(pos);
    if (picked?.id && this.wpEntities.includes(picked.id)) return;
    const pt = this.pickGround(pos);
    if (!pt) return;
    const w = this.waypoints();
    const altFt = Math.max(w.at(-1)?.altFt ?? 0, Math.ceil((pt.groundFt + 1000) / 500) * 500);
    this.update([...w, { name: `WP${w.length + 1}`, lat: pt.lat, lon: pt.lon, altFt, groundFt: pt.groundFt }]);
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
    const altM = egm96ToEllipsoid(s.lat, s.lon, s.altFt / FT);
    const ground = this.viewer.scene.globe.getHeight(Cartographic.fromDegrees(s.lon, s.lat));
    this.aglFt.set(ground !== undefined ? Math.round((altM - ground) * FT) : null);
    this.terrainWarn.set(ground !== undefined && altM < ground - 15);
    // In flight, show only the waypoint being flown to, from WAYPOINT_LEAD_S before arrival until it's reached.
    const next = this.waypoints()[s.next];
    const showNext = !!next && distanceM(s.lat, s.lon, next.lat, next.lon) / (Math.max(1, s.gsKt) * 0.514444) <= WAYPOINT_LEAD_S;
    this.wpEntities.forEach((e, i) => {
      const show = i === s.next && showNext;
      if (e.show !== show) e.show = show;
    });
    // Looking sideways, aircraft roll shows up as view pitch and aircraft pitch as view roll.
    const yaw = VIEWS[this.view()].yaw + this.look.yaw, y = CMath.toRadians(yaw);
    this.viewer.camera.setView({
      destination: Cartesian3.fromDegrees(s.lon, s.lat, Math.max(altM, (ground ?? -1000) + 1) + EYE_M),
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
        text: this.mode() === 'plan' ? `${i + 1}. ${w.name}\n${w.altFt} ft` : w.name, // index + altitude while planning
        font: '13px sans-serif', style: LabelStyle.FILL_AND_OUTLINE,
        outlineWidth: 3, outlineColor: Color.BLACK, verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, -12), disableDepthTestDistance: Infinity,
      },
    }));
    if (pos.length > 1 && this.mode() === 'plan') { // route lines only while planning
      v.entities.add({ polyline: { positions: pos, width: 2, clampToGround: true, material: Color.YELLOW.withAlpha(0.5) } });
    }
  }

  private async refreshTerrainProfile() {
    const wps = this.waypoints();
    const seq = ++this.profileSeq;
    if (wps.length < 2) {
      this.terrainSamples.set([]);
      return;
    }
    const pts: { lat: number; lon: number; distNm: number }[] = [];
    let cumNm = 0;
    for (let i = 0; i < wps.length - 1; i++) {
      const a = wps[i], b = wps[i + 1];
      const legNm = distanceM(a.lat, a.lon, b.lat, b.lon) / 1852;
      const steps = Math.max(2, Math.min(12, Math.ceil(legNm / 2)));
      for (let s = 0; s < steps; s++) {
        const f = s / steps;
        pts.push({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, distNm: cumNm + legNm * f });
      }
      cumNm += legNm;
    }
    const last = wps[wps.length - 1];
    pts.push({ lat: last.lat, lon: last.lon, distNm: cumNm });

    if (!this.hasToken || !this.viewer?.terrainProvider) {
      this.terrainSamples.set(pts.map((p) => ({ distNm: p.distNm, groundFt: 0 })));
      return;
    }
    try {
      const cartos = pts.map((p) => Cartographic.fromDegrees(p.lon, p.lat));
      const updated = await sampleTerrainMostDetailed(this.viewer.terrainProvider, cartos);
      if (seq !== this.profileSeq) return;
      this.terrainSamples.set(updated.map((c, i) => ({
        distNm: pts[i].distNm,
        groundFt: Math.round(ellipsoidToEgm96(pts[i].lat, pts[i].lon, c.height || 0) * FT),
      })));
    } catch {
      if (seq === this.profileSeq) this.terrainSamples.set([]);
    }
  }

  private overview() {
    (this.viewer.camera.frustum as PerspectiveFrustum).fov = CMath.toRadians(60);
    if (this.waypoints().length > 1) this.viewer.zoomTo(this.viewer.entities);
    else this.viewer.camera.setView({ destination: Cartesian3.fromDegrees(35.0, 31.4, 550000) });
  }

  private pushHistory(prev: Waypoint[]) {
    this.history.update((h) => [...h.slice(-29), prev]);
  }

  private notify(text: string, kind: 'info' | 'error' = 'info') {
    this.status.set({ text, kind });
  }

  protected update(wps: Waypoint[], record = true) {
    if (record) this.pushHistory(this.waypoints());
    this.waypoints.set(wps);
    saveRoute(wps);
    this.draw();
    this.refreshTerrainProfile();
  }

  protected undo() {
    const h = this.history();
    if (!h.length) return;
    const prev = h[h.length - 1];
    this.history.set(h.slice(0, -1));
    this.update(prev, false);
    this.notify('Undid last change');
  }

  protected requestClear() {
    if (!this.waypoints().length) return;
    this.clearDialog()?.nativeElement.showModal();
  }

  protected onClearDialogClose() {
    const dlg = this.clearDialog()?.nativeElement;
    if (!dlg) return;
    const confirmed = dlg.returnValue === 'confirm';
    dlg.returnValue = '';
    if (confirmed) {
      this.update([]);
      this.notify('Route cleared');
    }
  }

  protected resetDefault() {
    this.update(DEFAULT_ROUTE);
    this.overview();
    this.notify('Restored default route');
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

  protected editWind(key: keyof Wind, input: HTMLInputElement) {
    this.wind.set(setWind(this.wind(), key, input.value));
    input.value = String(this.wind()[key]);
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

  protected insertBetween(i: number) {
    const wps = [...this.waypoints()], a = wps[i], b = wps[i + 1];
    if (!a || !b) return;
    const mid: Waypoint = {
      name: `WP${wps.length + 1}`,
      lat: (a.lat + b.lat) / 2,
      lon: (a.lon + b.lon) / 2,
      altFt: Math.round((a.altFt + b.altFt) / 2 / 100) * 100,
    };
    wps.splice(i + 1, 0, mid);
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
    this.notify('Exported route.json');
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
      this.notify(`Imported ${waypoints.length} waypoints from ${file.name}`);
    } catch (e) {
      this.notify(`Could not import route: ${(e as Error).message}`, 'error');
    }
  }

  protected fly() {
    if (this.trajectory().length < 2) return;
    this.look = { yaw: 0, pitch: 0, dragging: false };
    this.lookOffset.set(false);
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
    this.shortcutsOpenFallback.set(false);
    this.draw();
    this.viewer.scene.screenSpaceCameraController.enableInputs = true;
    this.overview();
  }

  protected toggleShortcutsFallback() {
    if (this.supportsPopover) return;
    const next = !this.shortcutsOpenFallback();
    this.shortcutsOpenFallback.set(next);
    this.shortcutsPopover()?.nativeElement.classList.toggle(':popover-open', next);
  }

  protected seek(t: number) {
    this.simT.set(t);
  }

  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (this.mode() === 'plan' && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      this.undo();
      return;
    }
    if (this.mode() !== 'fly') return;
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

  protected fmtShort(s: number) {
    const m = Math.round(s / 60);
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
  }

  protected fmtDeg(d: number) {
    return String(Math.round(d) % 360 || 360).padStart(3, '0');
  }
}
