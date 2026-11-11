'use client';
// Light / dark / device theme switch. The choice is kept in this browser only (localStorage);
// THEME_SCRIPT (./theme-script) applies it before first paint, so pages never flash.
import { useSyncExternalStore } from 'react';
import { THEME_KEY as KEY } from './theme-script';

type Choice = 'system' | 'light' | 'dark';
const ORDER: Choice[] = ['system', 'light', 'dark'];
const LABEL: Record<Choice, string> = {
  system: 'Theme: device setting',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

function apply(choice: Choice) {
  const dark =
    choice === 'dark' ||
    (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

function Icon({ choice }: { choice: Choice }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  if (choice === 'light')
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  if (choice === 'dark')
    return (
      <svg {...common}>
        <path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11Z" />
      </svg>
    );
  return (
    <svg {...common}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

/** The saved choice (this browser), or the device setting when none is saved or readable. */
function readChoice(): Choice {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  } catch {
    return 'system';
  }
}
const CHANGED = 'cbr-theme-change';
function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(CHANGED, onChange);
  };
}

export function ThemeToggle() {
  // The server renders the device-setting icon; the browser then shows the saved choice.
  const choice = useSyncExternalStore(subscribe, readChoice, () => 'system' as Choice);

  const next = () => {
    const to = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length]!;
    try {
      if (to === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, to);
    } catch {
      /* not saved; still applied for this page */
    }
    apply(to);
    window.dispatchEvent(new Event(CHANGED));
  };

  return (
    <button
      type="button"
      onClick={next}
      title={`${LABEL[choice]} (change)`}
      aria-label={`${LABEL[choice]}. Change theme`}
      className="tap inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-700 transition hover:border-gold-400 hover:text-blue-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-400"
    >
      <Icon choice={choice} />
    </button>
  );
}
