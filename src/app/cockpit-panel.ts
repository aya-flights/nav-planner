import { Component, input } from '@angular/core';
import type { FlightState } from './flight';

export interface NavInfo { name: string; distNm: number; eteSec: number; }

const range = (from: number, to: number, step: number) =>
  Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** Point at radius r and angle a (deg, 0 = up, clockwise). */
const polar = (r: number, a: number) => {
  const t = ((a - 90) * Math.PI) / 180;
  return { x: r * Math.cos(t), y: r * Math.sin(t) };
};
const arc = (r: number, a0: number, a1: number) => {
  const p = polar(r, a0), q = polar(r, a1);
  return `M${p.x} ${p.y} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${q.x} ${q.y}`;
};
const asiA = (kt: number) => clamp(kt, 0, 200) * 1.6;
const vsiA = (fpm: number) => 270 + clamp(fpm, -2000, 2000) * 0.085;

/** Cessna 172 glareshield, windshield frame and classic six-pack, drawn over the out-the-window view. */
@Component({
  selector: 'app-cockpit-panel',
  styles: `:host { position: fixed; inset: 0; pointer-events: none; z-index: 2; }
    svg { width: 100%; height: 100%; display: block; font-family: system-ui, sans-serif; }
    .dial { fill: #fff; font-size: 13px; text-anchor: middle; dominant-baseline: middle; }
    .lcd { fill: #6f6; font: 15px ui-monospace, monospace; }`,
  template: `
<!-- low: taller viewBox pushes the panel down; it ends at y=720 so the bottom gauge row is cut off -->
<svg [attr.viewBox]="low() ? '0 -300 1600 1020' : '0 -110 1600 1010'" preserveAspectRatio="xMidYMax slice">
  <!-- windshield frame + compass -->
  <path [attr.d]="'M0 -400 H1600 V' + top() + ' H0 Z M0 -400 H-20 L190 520 H0 Z M1600 -400 H1620 L1410 520 H1600 Z'" fill="#202224" />
  <g [attr.transform]="'translate(800 ' + top() + ')'">
    <rect x="-34" y="0" width="68" height="34" rx="6" fill="#111" />
    <text class="lcd" x="0" y="23" text-anchor="middle" fill="#fff">{{ compass() }}</text>
  </g>
  <path d="M0 515 Q800 465 1600 515 V900 H0 Z" fill="#17181a" />
  <path d="M0 540 Q800 500 1600 540 V900 H0 Z" fill="#45484c" />

  <!-- Airspeed -->
  <g transform="translate(380 630)">
    <circle r="84" fill="#1a1a1a" /><circle r="77" fill="#050505" />
    <path [attr.d]="arc(66, asiA(33), asiA(85))" stroke="#fff" stroke-width="6" fill="none" />
    <path [attr.d]="arc(72, asiA(44), asiA(129))" stroke="#2c2" stroke-width="7" fill="none" />
    <path [attr.d]="arc(72, asiA(129), asiA(163))" stroke="#ee2" stroke-width="7" fill="none" />
    <g [attr.transform]="'rotate(' + asiA(163) + ')'"><line y1="-77" y2="-62" stroke="#e22" stroke-width="4" /></g>
    @for (k of asiTicks; track k) {
      <g [attr.transform]="'rotate(' + asiA(k) + ')'"><line y1="-77" [attr.y2]="k % 20 ? -70 : -65" stroke="#fff" stroke-width="2" /></g>
    }
    @for (k of asiLabels; track k) {
      <text class="dial" [attr.x]="polar(52, asiA(k)).x" [attr.y]="polar(52, asiA(k)).y">{{ k }}</text>
    }
    <text class="dial" y="22" font-size="10">KNOTS</text>
    <g [attr.transform]="'rotate(' + asiA(state().kias) + ')'"><path d="M-3 12 L0 -72 L3 12 Z" fill="#fff" /></g>
    <circle r="6" fill="#333" />
  </g>

  <!-- Attitude -->
  <g transform="translate(580 630)">
    <circle r="84" fill="#1a1a1a" />
    <clipPath id="ai-clip"><circle r="77" /></clipPath>
    <g clip-path="url(#ai-clip)">
      <g [attr.transform]="'rotate(' + -state().roll + ') translate(0 ' + clamp(state().pitch, -25, 25) * 4 + ')'">
        <rect x="-200" y="-400" width="400" height="400" fill="#2f7fd0" />
        <rect x="-200" y="0" width="400" height="400" fill="#8b5a2b" />
        <line x1="-200" x2="200" stroke="#fff" stroke-width="2" />
        @for (p of ladder; track p) {
          <line [attr.x1]="p % 10 ? -10 : -22" [attr.x2]="p % 10 ? 10 : 22" [attr.y1]="-p * 4" [attr.y2]="-p * 4" stroke="#fff" stroke-width="2" />
        }
      </g>
      <g [attr.transform]="'rotate(' + -state().roll + ')'"><path d="M0 -66 L-7 -54 H7 Z" fill="#fff" /></g>
    </g>
    @for (b of bankTicks; track b) {
      <g [attr.transform]="'rotate(' + b + ')'"><line y1="-77" [attr.y2]="b % 30 ? -70 : -64" stroke="#fff" stroke-width="2" /></g>
    }
    <path d="M0 -77 L-6 -88 H6 Z" fill="#f80" />
    <path d="M-50 0 H-16 L-8 8 M50 0 H16 L8 8" stroke="#f80" stroke-width="5" fill="none" />
    <circle r="3" fill="#f80" />
  </g>

  <!-- Altimeter -->
  <g transform="translate(780 630)">
    <circle r="84" fill="#1a1a1a" /><circle r="77" fill="#050505" />
    @for (i of altTicks; track i) {
      <g [attr.transform]="'rotate(' + i * 7.2 + ')'"><line y1="-77" [attr.y2]="i % 5 ? -71 : -63" stroke="#fff" stroke-width="2" /></g>
    }
    @for (d of digits; track d) {
      <text class="dial" font-size="16" [attr.x]="polar(52, d * 36).x" [attr.y]="polar(52, d * 36).y">{{ d }}</text>
    }
    <text class="dial" y="24" font-size="9">100 FEET</text>
    <g [attr.transform]="'rotate(' + ((state().altFt % 10000) + 10000) * 0.036 + ')'"><path d="M-6 8 L0 -42 L6 8 Z" fill="#fff" /></g>
    <g [attr.transform]="'rotate(' + state().altFt * 0.36 + ')'"><path d="M-3 12 L0 -72 L3 12 Z" fill="#fff" /></g>
    <circle r="6" fill="#333" />
  </g>

  @if (!low()) {
  <!-- Turn coordinator -->
  <g transform="translate(380 812)">
    <circle r="84" fill="#1a1a1a" /><circle r="77" fill="#050505" />
    @for (m of [90, 110, 250, 270]; track m) {
      <g [attr.transform]="'rotate(' + m + ')'"><line y1="-74" y2="-62" stroke="#fff" stroke-width="3" /></g>
    }
    <text class="dial" x="-50" y="44" font-size="14">L</text>
    <text class="dial" x="50" y="44" font-size="14">R</text>
    <text class="dial" y="-38" font-size="9">2 MIN</text>
    <rect x="-34" y="30" width="68" height="16" rx="8" fill="#ddd" opacity=".25" />
    <circle cy="38" r="7" fill="#111" stroke="#aaa" />
    <g [attr.transform]="'rotate(' + clamp(state().turnRate / 3 * 20, -35, 35) + ')'">
      <path d="M-58 0 H58" stroke="#fff" stroke-width="5" />
      <circle r="9" fill="#fff" /><path d="M0 -8 V-20 M-12 -16 H12" stroke="#fff" stroke-width="4" />
    </g>
  </g>

  <!-- Heading indicator -->
  <g transform="translate(580 812)">
    <circle r="84" fill="#1a1a1a" /><circle r="77" fill="#050505" />
    <g [attr.transform]="'rotate(' + -state().heading + ')'">
      @for (h of hdgTicks; track h) {
        <g [attr.transform]="'rotate(' + h + ')'"><line y1="-74" [attr.y2]="h % 10 ? -69 : -63" stroke="#fff" stroke-width="2" /></g>
      }
      @for (h of hdgLabels; track h.a) {
        <g [attr.transform]="'rotate(' + h.a + ')'"><text class="dial" y="-50" font-size="15">{{ h.t }}</text></g>
      }
    </g>
    <path d="M0 -78 L-6 -88 H6 Z" fill="#f80" />
    <path d="M0 -30 V22 M-26 -2 H26 M-10 18 H10" stroke="#f80" stroke-width="4" />
  </g>

  <!-- Vertical speed -->
  <g transform="translate(780 812)">
    <circle r="84" fill="#1a1a1a" /><circle r="77" fill="#050505" />
    @for (v of vsiTicks; track v) {
      <g [attr.transform]="'rotate(' + vsiA(v) + ')'"><line y1="-77" [attr.y2]="v % 500 ? -71 : -64" stroke="#fff" stroke-width="2" /></g>
    }
    @for (v of vsiLabels; track v) {
      <text class="dial" [attr.x]="polar(52, vsiA(v)).x" [attr.y]="polar(52, vsiA(v)).y">{{ abs(v) / 100 }}</text>
    }
    <text class="dial" x="22" y="-16" font-size="9">UP</text>
    <text class="dial" x="22" y="18" font-size="9">DOWN</text>
    <g [attr.transform]="'rotate(' + vsiA(state().vsFpm) + ')'"><path d="M-3 12 L0 -72 L3 12 Z" fill="#fff" /></g>
    <circle r="6" fill="#333" />
  </g>

  }

  <!-- GPS-ish nav box + annunciator -->
  <g transform="translate(960 590)">
    <rect width="380" height="130" rx="8" fill="#0a0d0a" stroke="#222" stroke-width="4" />
    <text class="lcd" x="16" y="30">NEXT {{ nav().name }}</text>
    <text class="lcd" x="16" y="58">DIST {{ nav().distNm.toFixed(1) }} NM  ETE {{ fmt(nav().eteSec) }}</text>
    <text class="lcd" x="16" y="86">GS {{ state().kias.toFixed(0) }} KT  ALT {{ state().altFt.toFixed(0) }} FT</text>
    <text class="lcd" x="16" y="114">HDG {{ compass() }}  VS {{ state().vsFpm.toFixed(0) }}</text>
  </g>
  <g transform="translate(1360 590)">
    <rect width="110" height="34" rx="4" [attr.fill]="terrain() ? '#d22' : '#311'" />
    <text x="55" y="22" text-anchor="middle" font-size="14" font-weight="700" [attr.fill]="terrain() ? '#fff' : '#633'">TERRAIN</text>
  </g>
</svg>`,
})
export class CockpitPanel {
  state = input.required<FlightState>();
  nav = input.required<NavInfo>();
  terrain = input(false);
  low = input(false);
  /** Bottom edge of the windshield top bar: stays a thin strip at the top of the screen in both layouts. */
  protected top = () => (this.low() ? -264 : 36);

  protected readonly arc = arc;
  protected readonly polar = polar;
  protected readonly clamp = clamp;
  protected readonly asiA = asiA;
  protected readonly vsiA = vsiA;
  protected readonly abs = Math.abs;
  protected readonly asiTicks = range(30, 200, 10);
  protected readonly asiLabels = range(40, 200, 20);
  protected readonly ladder = [-20, -15, -10, -5, 5, 10, 15, 20];
  protected readonly bankTicks = [-60, -30, -20, -10, 10, 20, 30, 60];
  protected readonly altTicks = range(0, 49, 1);
  protected readonly digits = range(0, 9, 1);
  protected readonly hdgTicks = range(0, 355, 5);
  protected readonly hdgLabels = range(0, 330, 30).map((a) => ({ a, t: ({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' } as Record<number, string>)[a] ?? String(a / 10) }));
  protected readonly vsiTicks = range(-2000, 2000, 100);
  protected readonly vsiLabels = [-1500, -1000, -500, 0, 500, 1000, 1500, 2000];

  protected compass = () => String(Math.round(this.state().heading) % 360 || 360).padStart(3, '0');
  protected fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
