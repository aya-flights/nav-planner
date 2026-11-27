import { AfterViewInit, Component, ElementRef, OnChanges, OnDestroy, SimpleChanges, input, viewChild } from '@angular/core';
import * as L from 'leaflet';
import { FlightState } from './flight';
import { Waypoint } from './route';

@Component({
  selector: 'app-moving-map',
  standalone: true,
  template: `<div #mapContainer class="leaflet-container-view"></div>`,
  styles: [`
    :host {
      display: block;
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      z-index: 0;
      background: #111;
    }
    .leaflet-container-view {
      width: 100%;
      height: 100%;
    }
    :host ::ng-deep .plane-marker {
      background: transparent;
      border: none;
    }
    :host ::ng-deep .wp-label {
      background: rgba(10, 16, 24, 0.85);
      color: #ffd84d;
      border: 1px solid rgba(255, 216, 77, 0.4);
      border-radius: 4px;
      padding: 1px 5px;
      font-size: 11px;
      font-weight: 600;
      box-shadow: 0 2px 6px rgba(0,0,0,0.4);
    }
    :host ::ng-deep .wp-marker-pin {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #ffd84d;
      border: 2px solid #000;
      box-shadow: 0 0 4px rgba(255, 216, 77, 0.8);
    }
  `],
})
export class MovingMap implements AfterViewInit, OnDestroy, OnChanges {
  readonly state = input<FlightState | null>(null);
  readonly waypoints = input<Waypoint[]>([]);
  readonly trajectory = input<FlightState[]>([]);

  private readonly mapContainer = viewChild.required<ElementRef<HTMLDivElement>>('mapContainer');
  private map?: L.Map;
  private planeMarker?: L.Marker;
  private routeLine?: L.Polyline;
  private trailLine?: L.Polyline;
  private wpLayerGroup?: L.LayerGroup;

  // Track flown points for breadcrumb trail
  private flownPoints: [number, number][] = [];

  ngAfterViewInit(): void {
    this.initMap();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.map) return;

    if (changes['waypoints'] || changes['trajectory']) {
      this.updateRouteVisuals();
    }

    if (changes['state']) {
      this.updateAircraftState();
    }
  }

  ngOnDestroy(): void {
    if (this.map) {
      this.map.remove();
      this.map = undefined;
    }
  }

  private initMap(): void {
    const el = this.mapContainer().nativeElement;
    const initialLat = this.state()?.lat ?? this.waypoints()[0]?.lat ?? 32.18;
    const initialLon = this.state()?.lon ?? this.waypoints()[0]?.lon ?? 34.83;

    this.map = L.map(el, {
      center: [initialLat, initialLon],
      zoom: 12,
      zoomControl: true,
      attributionControl: true,
    });

    // CartoDB dark/voyager or OpenStreetMap tiles. Standard OpenStreetMap provides high fidelity aviation/topographic references.
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(this.map);

    this.wpLayerGroup = L.layerGroup().addTo(this.map);
    this.updateRouteVisuals();
    this.updateAircraftState();

    // Ensure size fits container once rendered
    setTimeout(() => {
      this.map?.invalidateSize();
    }, 50);
  }

  private updateRouteVisuals(): void {
    if (!this.map) return;

    // 1. Draw planned trajectory
    const traj = this.trajectory();
    const trajCoords: [number, number][] = traj.length > 0
      ? traj.map(pt => [pt.lat, pt.lon])
      : this.waypoints().map(wp => [wp.lat, wp.lon]);

    if (this.routeLine) {
      this.routeLine.setLatLngs(trajCoords);
    } else if (trajCoords.length > 0) {
      this.routeLine = L.polyline(trajCoords, {
        color: '#ffaa00',
        weight: 3,
        opacity: 0.85,
        dashArray: '6, 6',
      }).addTo(this.map);
    }

    // 2. Draw waypoints
    if (this.wpLayerGroup) {
      this.wpLayerGroup.clearLayers();
      const wps = this.waypoints();
      wps.forEach((wp, idx) => {
        const pinIcon = L.divIcon({
          className: 'plane-marker',
          html: `<div class="wp-marker-pin"></div>`,
          iconSize: [12, 12],
          iconAnchor: [6, 6],
        });

        const marker = L.marker([wp.lat, wp.lon], { icon: pinIcon });
        marker.bindTooltip(`${idx + 1}. ${wp.name} (${Math.round(wp.altFt)} ft)`, {
          permanent: true,
          direction: 'top',
          className: 'wp-label',
          offset: [0, -8],
        });
        marker.addTo(this.wpLayerGroup!);
      });
    }
  }

  private updateAircraftState(): void {
    if (!this.map) return;
    const st = this.state();
    if (!st) return;

    const latLng: [number, number] = [st.lat, st.lon];

    // Maintain recent trail
    if (this.flownPoints.length === 0 ||
        Math.hypot(this.flownPoints[this.flownPoints.length - 1][0] - st.lat, this.flownPoints[this.flownPoints.length - 1][1] - st.lon) > 0.0002) {
      // If time scrubbed backwards, reset trail
      if (this.flownPoints.length > 2 && st.t === 0) {
        this.flownPoints = [latLng];
      } else {
        this.flownPoints.push(latLng);
      }
    }

    if (this.trailLine) {
      this.trailLine.setLatLngs(this.flownPoints);
    } else {
      this.trailLine = L.polyline(this.flownPoints, {
        color: '#00e5ff',
        weight: 4,
        opacity: 0.9,
      }).addTo(this.map);
    }

    // Airplane icon with heading rotation
    const heading = Math.round(st.heading);
    const planeHtml = `
      <div style="transform: rotate(${heading}deg); transform-origin: 50% 50%; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.6));">
        <svg viewBox="0 0 24 24" width="32" height="32" fill="#00e5ff" stroke="#000000" stroke-width="1.2">
          <path d="M12 2 L14 9 L21 13 L21 15 L14 13.5 L14 18 L16 20 L16 21.5 L12 20.5 L8 21.5 L8 20 L10 18 L10 13.5 L3 15 L3 13 L10 9 Z"/>
        </svg>
      </div>
    `;

    const planeIcon = L.divIcon({
      className: 'plane-marker',
      html: planeHtml,
      iconSize: [36, 36],
      iconAnchor: [18, 18],
    });

    if (this.planeMarker) {
      this.planeMarker.setLatLng(latLng);
      this.planeMarker.setIcon(planeIcon);
    } else {
      this.planeMarker = L.marker(latLng, { icon: planeIcon, zIndexOffset: 1000 }).addTo(this.map);
    }

    // Keep map centered on aircraft
    this.map.panTo(latLng, { animate: false });
  }
}
