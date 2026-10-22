// Small inline stroke icon set (24 px grid, drawn at 14–16 px). No icon font or CDN.
const PATHS = {
  home: "M3 11l9-7 9 7M5 10v10h5v-6h4v6h5V10",
  dashboard: "M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  building: "M4 21V4h10v17M14 9h6v12M7 8h3M7 12h3M7 16h3M3 21h18",
  wallet: "M4 7h14a2 2 0 012 2v9a2 2 0 01-2 2H4zM4 7l11-3v3M16 13h2",
  file: "M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6",
  scale: "M12 4v16M5 20h14M6 8l-3 6h6zM18 8l-3 6h6zM6 8h12",
  calculator: "M6 3h12v18H6zM9 7h6M9 12h1M14 12h1M9 16h1M14 16h1",
  coins: "M9 7a5 3 0 1010 0 5 3 0 10-10 0M9 7v5c0 1.7 2.2 3 5 3s5-1.3 5-3V7M5 12a5 3 0 005 3M5 12v5c0 1.7 2.2 3 5 3",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  tag: "M3 12V4h8l10 10-8 8zM7.5 8.5h.01",
  inbox: "M3 13l3-8h12l3 8v6H3zM3 13h5l1 2h6l1-2h5",
  trending: "M3 17l6-6 4 4 8-8M15 7h6v6",
  layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5",
  folder: "M3 6h6l2 2h10v11H3z",
  globe: "M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
  grid: "M4 4h16v16H4zM4 10h16M4 15h16M10 4v16M15 4v16",
  book: "M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3zM5 17a3 3 0 013-3h11",
  route: "M6 19a2 2 0 100-4 2 2 0 000 4zM18 9a2 2 0 100-4 2 2 0 000 4zM6 15V9a3 3 0 013-3h7M18 9v6a3 3 0 01-3 3H8",
  map: "M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3zM9 3v15M15 6v15",
  sort: "M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4",
  refresh: "M20 11a8 8 0 00-14-5L4 8M4 4v4h4M4 13a8 8 0 0014 5l2-2M20 20v-4h-4",
  search: "M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4",
  play: "M7 4l13 8-13 8z",
  pause: "M8 5v14M16 5v14",
  minus: "M5 12h14",
  shuffle: "M3 7h4l10 10h4M3 17h4l3-3M14 10l3-3h4M18 4l3 3-3 3M18 14l3 3-3 3",
  radar: "M12 3a9 9 0 109 9M12 7a5 5 0 105 5M12 12l7-7",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  gauge: "M4 18a8 8 0 1116 0M12 14l4-5",
  mail: "M3 6h18v12H3zM3 6l9 7 9-7",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  phone: "M5 3h4l2 5-3 2a11 11 0 006 6l2-3 5 2v4a2 2 0 01-2 2A17 17 0 013 5a2 2 0 012-2z",
  megaphone: "M3 10v4h4l8 5V5L7 10zM18 9a4 4 0 010 6",
  bell: "M6 16V11a6 6 0 0112 0v5l2 2H4zM10 20a2 2 0 004 0",
  alert: "M12 3l10 18H2zM12 10v5M12 18h.01",
  download: "M12 4v12M7 11l5 5 5-5M4 20h16",
  upload: "M12 20V8M7 13l5-5 5 5M4 4h16",
  network: "M12 4v6M5 20v-4h14v4M12 10v6M9 4h6v6H9zM3 20h4M17 20h4",
  wave: "M2 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0 2 2 2 0",
  terminal: "M4 5h16v14H4zM8 10l3 2-3 2M13 15h3",
  send: "M4 12l16-8-6 16-3-7z",
  chart: "M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-8",
  users: "M9 11a4 4 0 100-8 4 4 0 000 8zM2 21a7 7 0 0114 0M16 3a4 4 0 010 8M22 21a7 7 0 00-5-6.7",
  clock: "M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v5l3 2",
  history: "M4 12a8 8 0 108-8 8 8 0 00-7 4M4 4v4h4M12 8v4l3 2",
  key: "M15 9a4 4 0 11-8 0 4 4 0 018 0zM13.5 11.5L21 19l-2 2-2-2-1 1-2-2 1-1-2.5-2.5",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z",
  monitor: "M3 4h18v12H3zM8 20h8M12 16v4",
  lock: "M6 11h12v10H6zM8 11V7a4 4 0 018 0v4",
  sparkles: "M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2zM19 15l1 2 2 1-2 1-1 2-1-2-2-1 2-1z",
  x: "M6 6l12 12M18 6L6 18",
  plus: "M12 5v14M5 12h14",
  chevronDown: "M6 9l6 6 6-6",
  chevronRight: "M9 6l6 6-6 6",
  arrowLeft: "M19 12H5M11 6l-6 6 6 6",
  arrowUpRight: "M7 17L17 7M9 7h8v8",
  arrowDownLeft: "M17 7L7 17M15 17H7V9",
  undo: "M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3",
  filter: "M3 5h18l-7 8v6l-4 2v-8z",
  star: "M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z",
  pin: "M9 3h6l-1 6 4 4H6l4-4zM12 13v8",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  columns: "M4 4h16v16H4zM9.5 4v16M14.5 4v16",
  check: "M5 12l5 5 9-10",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  sun: "M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  moon: "M20 14A8 8 0 1110 4a6.5 6.5 0 0010 10z",
  dock: "M4 4h16v16H4zM4 9h16M9 14l3 3 3-3M12 17v-6",
  user: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0",
  logout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10",
  split: "M4 4h16v16H4zM12 4v16",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  save: "M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6",
  copy: "M8 8h12v12H8zM4 16V4h12",
  help: "M12 21a9 9 0 100-18 9 9 0 000 18zM9.5 9.5a2.5 2.5 0 114 2c-1 .6-1.5 1.2-1.5 2.5M12 17h.01",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 15, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
