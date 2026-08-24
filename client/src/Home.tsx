import { ChevronLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { OnboardingGuide } from './Onboarding';

/** Where a card takes you — the App's view names, narrowed to the ones the junction offers. */
export type HomeDestination = 'month' | 'plan' | 'year' | 'overview' | 'patterns' | 'future' | 'health' | 'networth';

function greetingHe(hour: number): string {
  if (hour >= 5 && hour < 12) return 'בוקר טוב';
  if (hour >= 12 && hour < 17) return 'צהריים טובים';
  if (hour >= 17 && hour < 22) return 'ערב טוב';
  return 'לילה טוב';
}

/* ——— the artwork: hand-drawn SVG scenes, one small world per destination ———
   Flat shapes + soft gradients, no emoji, no icon-font. Each scene lives in its
   card's palette and scales with the card (viewBox only, width 100%). */

function ArtMonth() {
  // a warm sun rising behind the month's calendar — the running month, day after day
  return (
    <svg viewBox="0 0 220 130" className="bento-svg" aria-hidden="true">
      <defs>
        <linearGradient id="am-sun" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffd166" />
          <stop offset="1" stopColor="#ffb020" />
        </linearGradient>
        <linearGradient id="am-cal" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0.78" />
        </linearGradient>
      </defs>
      {/* rays */}
      {Array.from({ length: 8 }, (_, i) => {
        const a = (i / 8) * Math.PI * 2;
        return (
          <line
            key={i}
            x1={62 + Math.cos(a) * 34} y1={52 + Math.sin(a) * 34}
            x2={62 + Math.cos(a) * 44} y2={52 + Math.sin(a) * 44}
            stroke="#ffb020" strokeWidth="5" strokeLinecap="round" opacity="0.85"
          />
        );
      })}
      <circle cx="62" cy="52" r="26" fill="url(#am-sun)" />
      {/* calendar card */}
      <rect x="96" y="30" width="102" height="86" rx="14" fill="url(#am-cal)" />
      <rect x="96" y="30" width="102" height="24" rx="14" fill="#5b2be0" opacity="0.9" />
      <rect x="96" y="42" width="102" height="12" fill="#5b2be0" opacity="0.9" />
      {/* rings */}
      <rect x="116" y="22" width="6" height="16" rx="3" fill="#3d1d99" />
      <rect x="172" y="22" width="6" height="16" rx="3" fill="#3d1d99" />
      {/* day dots — the walked days full, the rest hollow */}
      {Array.from({ length: 12 }, (_, i) => {
        const cx = 112 + (i % 4) * 24;
        const cy = 68 + Math.floor(i / 4) * 18;
        const walked = i < 7;
        return walked
          ? <circle key={i} cx={cx} cy={cy} r="4.6" fill="#5b2be0" opacity="0.85" />
          : <circle key={i} cx={cx} cy={cy} r="4.2" fill="none" stroke="#5b2be0" strokeWidth="1.8" opacity="0.4" />;
      })}
      {/* today */}
      <circle cx={112 + 3 * 24} cy={68 + 18} r="7" fill="none" stroke="#ffb020" strokeWidth="2.6" />
    </svg>
  );
}

function ArtOverview() {
  // layered hills, a dashed trail climbing to a flag — the long view
  return (
    <svg viewBox="0 0 220 130" className="bento-svg" aria-hidden="true">
      <defs>
        <linearGradient id="ao-far" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7bd8a0" />
          <stop offset="1" stopColor="#3f9e6b" />
        </linearGradient>
        <linearGradient id="ao-near" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2f8f5b" />
          <stop offset="1" stopColor="#1d6b41" />
        </linearGradient>
      </defs>
      <path d="M0 108 Q45 48 92 84 Q128 110 160 88 Q190 68 220 82 L220 130 L0 130 Z" fill="url(#ao-far)" opacity="0.75" />
      <path d="M0 122 Q60 74 118 100 Q170 122 220 96 L220 130 L0 130 Z" fill="url(#ao-near)" />
      {/* the trail */}
      <path d="M18 118 Q70 108 104 88 Q150 62 178 40" fill="none" stroke="#ffffff" strokeWidth="3" strokeDasharray="1 9" strokeLinecap="round" opacity="0.95" />
      {/* summit flag */}
      <line x1="178" y1="40" x2="178" y2="16" stroke="#ffffff" strokeWidth="3" strokeLinecap="round" />
      <path d="M178 16 L200 22 L178 29 Z" fill="#ffd166" />
      {/* a soft sun far away */}
      <circle cx="40" cy="30" r="13" fill="#ffffff" opacity="0.55" />
    </svg>
  );
}

function ArtPatterns() {
  // orbits: what returns, returns — each family a moon in its own color
  return (
    <svg viewBox="0 0 200 200" className="bento-svg" aria-hidden="true">
      <defs>
        <radialGradient id="ap-core" cx="0.5" cy="0.42" r="0.7">
          <stop offset="0" stopColor="#8f6bff" />
          <stop offset="1" stopColor="#5b2be0" />
        </radialGradient>
      </defs>
      <circle cx="100" cy="100" r="34" fill="url(#ap-core)" />
      <circle cx="100" cy="100" r="33" fill="none" stroke="#ffffff" strokeWidth="1.4" opacity="0.35" />
      <ellipse cx="100" cy="100" rx="58" ry="58" fill="none" stroke="#5b2be0" strokeWidth="2" opacity="0.45" />
      <ellipse cx="100" cy="100" rx="80" ry="80" fill="none" stroke="#1e6091" strokeWidth="2" opacity="0.45" />
      <ellipse cx="100" cy="100" rx="97" ry="97" fill="none" stroke="#0f9d8f" strokeWidth="2" opacity="0.5" />
      {/* the moons */}
      <circle cx="100" cy="42" r="9.5" fill="#5b2be0" />
      <circle cx="169" cy="132" r="9.5" fill="#1e6091" />
      <circle cx="30" cy="140" r="9.5" fill="#0f9d8f" />
      {/* small sparks on the core */}
      <circle cx="88" cy="90" r="4" fill="#ffffff" opacity="0.5" />
    </svg>
  );
}

function ArtFuture() {
  // a telescope under a night sky — the horizon, before it happens
  return (
    <svg viewBox="0 0 220 130" className="bento-svg" aria-hidden="true">
      <defs>
        <linearGradient id="af-tube" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8f6bff" />
          <stop offset="1" stopColor="#4b21c4" />
        </linearGradient>
      </defs>
      {/* stars + a real crescent (two arcs, no background-colored mask) */}
      <path d="M186 12 A12.5 12.5 0 1 0 186 37 A9.8 9.8 0 1 1 186 12 Z" fill="#ffd166" />
      {[[24, 20, 2.4], [58, 34, 1.7], [96, 16, 2], [136, 36, 1.6], [206, 52, 1.8], [40, 56, 1.5]].map(([x, y, r], i) => (
        <circle key={i} cx={x} cy={y} r={r} fill="#a88fff" />
      ))}
      {/* telescope */}
      <g transform="rotate(-24 96 78)">
        <rect x="52" y="68" width="92" height="20" rx="10" fill="url(#af-tube)" />
        <rect x="138" y="64" width="18" height="28" rx="8" fill="#3d1d99" />
        <rect x="44" y="72" width="12" height="12" rx="6" fill="#3d1d99" />
      </g>
      <line x1="96" y1="88" x2="76" y2="122" stroke="#3d1d99" strokeWidth="5" strokeLinecap="round" />
      <line x1="96" y1="88" x2="118" y2="122" stroke="#3d1d99" strokeWidth="5" strokeLinecap="round" />
      {/* the beam */}
      <path d="M150 60 L196 30 L188 52 Z" fill="#8f6bff" opacity="0.25" />
    </svg>
  );
}

function ArtHealth() {
  // a heart with a living pulse — the money's heartbeat
  return (
    <svg viewBox="0 0 220 130" className="bento-svg" aria-hidden="true">
      <defs>
        <linearGradient id="ah-heart" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ff8f7d" />
          <stop offset="1" stopColor="#e8543f" />
        </linearGradient>
      </defs>
      <path
        d="M110 108 C74 84 58 66 58 48 C58 34 69 24 83 24 C94 24 104 30 110 40 C116 30 126 24 137 24 C151 24 162 34 162 48 C162 66 146 84 110 108 Z"
        fill="url(#ah-heart)"
      />
      {/* the pulse crossing through */}
      <path
        d="M40 64 L86 64 L96 44 L110 84 L122 56 L130 64 L180 64"
        fill="none" stroke="#ffffff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"
      />
      <circle cx="180" cy="64" r="4.5" fill="#ffffff" />
    </svg>
  );
}

function ArtNetWorth() {
  // a tree whose leaves are coins — wealth that grew, and keeps growing
  return (
    <svg viewBox="0 0 220 130" className="bento-svg" aria-hidden="true">
      <defs>
        <radialGradient id="an-leaf" cx="0.5" cy="0.4" r="0.75">
          <stop offset="0" stopColor="#3f9ecf" />
          <stop offset="1" stopColor="#1e6091" />
        </radialGradient>
      </defs>
      {/* ground */}
      <ellipse cx="110" cy="118" rx="72" ry="9" fill="#1e6091" opacity="0.25" />
      {/* trunk */}
      <path d="M104 118 Q106 88 98 72 M110 118 Q112 84 122 66 M110 118 L108 76" stroke="#8a5a33" strokeWidth="8" strokeLinecap="round" fill="none" />
      {/* canopy */}
      <circle cx="86" cy="52" r="26" fill="url(#an-leaf)" />
      <circle cx="126" cy="42" r="30" fill="url(#an-leaf)" />
      <circle cx="108" cy="64" r="22" fill="url(#an-leaf)" opacity="0.95" />
      {/* coin-fruit */}
      {[[80, 44], [122, 32], [140, 52], [100, 68]].map(([x, y], i) => (
        <g key={i}>
          <circle cx={x} cy={y} r="7.5" fill="#ffd166" />
          <circle cx={x} cy={y} r="7.5" fill="none" stroke="#c98a00" strokeWidth="1.4" opacity="0.6" />
        </g>
      ))}
      <path d="M170 96 l2.6 5.2 5.2 2.6 -5.2 2.6 -2.6 5.2 -2.6 -5.2 -5.2 -2.6 5.2 -2.6 Z" fill="#ffd166" opacity="0.8" />
    </svg>
  );
}

function ArtPlan() {
  // a ship's helm — the app's whole point in one shape: somewhere the household steers,
  // instead of only watching. The gold notch at the top is the heading you set.
  const spokes = Array.from({ length: 8 }, (_, i) => (i / 8) * Math.PI * 2 + Math.PI / 8);
  return (
    <svg viewBox="0 0 220 130" className="bento-svg" aria-hidden="true">
      <defs>
        <linearGradient id="apl-rim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e8608f" />
          <stop offset="1" stopColor="#c2255c" />
        </linearGradient>
      </defs>
      {/* the handles you actually grip */}
      {spokes.map((a, i) => (
        <circle key={`h${i}`} cx={110 + Math.cos(a) * 50} cy={66 + Math.sin(a) * 50} r="7" fill="url(#apl-rim)" />
      ))}
      {spokes.map((a, i) => (
        <line
          key={`s${i}`}
          x1={110 + Math.cos(a) * 12} y1={66 + Math.sin(a) * 12}
          x2={110 + Math.cos(a) * 47} y2={66 + Math.sin(a) * 47}
          stroke="#c2255c" strokeWidth="5" strokeLinecap="round" opacity="0.9"
        />
      ))}
      <circle cx="110" cy="66" r="40" fill="none" stroke="url(#apl-rim)" strokeWidth="9" />
      <circle cx="110" cy="66" r="13" fill="#c2255c" />
      <circle cx="110" cy="66" r="5.5" fill="#ffd166" />
      {/* the heading */}
      <path d="M110 6 l8.5 15 -17 0 Z" fill="#ffd166" />
    </svg>
  );
}

function ArtYear() {
  // twelve columns — a year's skyline; the months already lived are full, the rest hollow,
  // and the year's arc travels above them with the sun at midsummer
  const heights = [28, 36, 24, 40, 32, 46, 38, 30, 42, 34, 44, 50];
  return (
    <svg viewBox="0 0 220 130" className="bento-svg" aria-hidden="true">
      <defs>
        <linearGradient id="ay-bar" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#d84fc4" />
          <stop offset="1" stopColor="#b23aa6" />
        </linearGradient>
      </defs>
      <path
        d="M18 92 C 60 26, 160 26, 202 92"
        fill="none" stroke="#b23aa6" strokeWidth="3" strokeDasharray="1 9" strokeLinecap="round" opacity="0.5"
      />
      <circle cx="110" cy="42.5" r="10" fill="#ffd166" />
      {heights.map((h, i) => {
        const x = 13 + i * 16.5;
        const lived = i < 7;
        return lived
          ? <rect key={i} x={x} y={112 - h} width="10" height={h} rx="3" fill="url(#ay-bar)" opacity="0.9" />
          : <rect key={i} x={x + 0.9} y={112.9 - h} width="8.2" height={h - 1.8} rx="3" fill="none" stroke="#b23aa6" strokeWidth="1.8" opacity="0.45" />;
      })}
      <line x1="10" y1="112" x2="210" y2="112" stroke="#b23aa6" strokeWidth="2" strokeLinecap="round" opacity="0.35" />
    </svg>
  );
}

/* ——— the bento cards: unequal on purpose ——— */

const CARDS: {
  view: HomeDestination;
  title: string;
  slogan: string;
  /** the card's color world — tints the background, the border glow and the hover */
  color: string;
  size: 'b-4x2' | 'b-2x2' | 'b-2x1' | 'b-3x1' | 'b-4x1';
  art: ReactNode;
}[] = [
  // the tessellation is deliberate: two rows of the running month beside the helm, then the
  // looking-back doors, then the wide capital line closing the grid flush
  // A slogan is a plain promise of what sits behind the door, using household language.
  { view: 'month', title: 'איך אני החודש?', slogan: 'כמה נכנס, כמה יצא — וכמה עוד מותר', color: '#ffb020', size: 'b-4x2', art: <ArtMonth /> },
  { view: 'plan', title: 'התוכנית שלי', slogan: 'כמה אתה חוסך — וכמה מותר לבזבז', color: '#c2255c', size: 'b-2x2', art: <ArtPlan /> },
  { view: 'patterns', title: 'מה יורד לי כל חודש?', slogan: 'מנויים, קבועים ותשלומים — כמה הם עולים לך', color: '#5b2be0', size: 'b-2x2', art: <ArtPatterns /> },
  { view: 'overview', title: 'איך אני בכללי?', slogan: 'חודש רגיל שלך — כמה נכנס, כמה יוצא', color: '#2f8f5b', size: 'b-2x1', art: <ArtOverview /> },
  { view: 'year', title: 'איך עברה השנה?', slogan: 'חודש-חודש, מול שנה שעברה', color: '#b23aa6', size: 'b-2x1', art: <ArtYear /> },
  { view: 'future', title: 'ומה לגבי העתיד?', slogan: 'התחזית — כמה כסף יהיה לך בהמשך', color: '#6d43e8', size: 'b-2x1', art: <ArtFuture /> },
  { view: 'health', title: 'בריאות פיננסית', slogan: 'הדופק של הכסף שלך', color: '#e8543f', size: 'b-2x1', art: <ArtHealth /> },
  { view: 'networth', title: 'הון', slogan: 'כל מה שצברת, בשורה אחת', color: '#1e6091', size: 'b-4x1', art: <ArtNetWorth /> },
];

export function Home({ profileName, onNavigate, onOpenConnections, onSyncNow, onStartTour, syncing }: {
  profileName: string | null;
  onNavigate: (view: HomeDestination) => void;
  onOpenConnections: () => void;
  onSyncNow: () => void;
  onStartTour: () => void;
  syncing: boolean;
}) {
  const now = new Date();
  const hello = `${greetingHe(now.getHours())}${profileName ? `, ${profileName}` : ''}`;
  const dateHe = now.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div className="home">
      <div className="home-hello">
        <h2>{hello}</h2>
        <p className="home-hello-sub">{dateHe} · מה בא לך לראות עכשיו?</p>
      </div>

      {/* first-run guidance — renders only while the install is unbootstrapped */}
      <OnboardingGuide
        onOpenConnections={onOpenConnections}
        onSyncNow={onSyncNow}
        onStartTour={onStartTour}
        syncing={syncing}
      />

      <div className="home-grid">
        {CARDS.map((c) => (
          <button
            key={c.view}
            className={`bento-card ${c.size}`}
            style={{ '--bento': c.color } as React.CSSProperties}
            onClick={() => onNavigate(c.view)}
            aria-label={`${c.title} — כניסה`}
          >
            <span className="bento-art">{c.art}</span>
            <span className="bento-text">
              <span className="bento-title">{c.title}</span>
              <span className="bento-slogan">{c.slogan}</span>
            </span>
            <ChevronLeft size={18} strokeWidth={2.2} className="bento-go" aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );
}
