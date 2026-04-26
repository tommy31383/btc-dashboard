/**
 * Material You Warm Dark Theme — v4.3.20
 * Single source of truth cho palette + typography + spacing.
 * Source: Stitch design references trong assets/claude_design_ref/*.html
 *
 * Design: warm dark (amber/beige) + border-l-4 accent bar signature +
 * rounded-sm (2px) sharp edges + Space Grotesk/Inter/JetBrains Mono fonts.
 * NO Binance blue, NO cold palette.
 */

export const P = {
  // Backgrounds — Material You surface tones (warm dark)
  bg: "#131313",                    // surface / background
  card: "#1c1b1b",                  // surface-container-low (primary card)
  cardAlt: "#201f1f",               // surface-container
  surface: "#0e0e0e",               // surface-container-lowest (nested/deep)
  elevated: "#2a2a2a",              // surface-container-high
  highest: "#353534",               // surface-container-highest (chips bg)

  // Borders — warm outline
  border: "#514439",                // outline-variant (used for borders, dividers)
  borderSoft: "#2a2a2a",            // soft border same as elevated
  borderStrong: "#9f8e80",          // outline (emphasized borders)
  divider: "#514439",               // same family as border
  grid: "#514439",                  // chart grid

  // Text — on-surface hierarchy
  text: "#e5e2e1",                  // on-surface (primary text)
  text2: "#d6c3b4",                 // on-surface-variant (secondary warm beige)
  dim: "#9f8e80",                   // outline (labels, captions)
  fade: "#514439",                  // outline-variant (faded/disabled)

  // Semantic — Material You warm palette
  primary: "#ffdcc0",               // primary (soft peach, text on dark)
  primaryContainer: "#ffb874",      // primary-container (warm amber, accent bar)
  onPrimary: "#4b2800",             // on-primary (dark text on amber)
  onPrimaryContainer: "#79470b",    // on-primary-container

  secondary: "#ffb874",             // same family as primaryContainer
  secondaryContainer: "#e78603",    // deep orange (active tabs)
  onSecondary: "#4b2800",

  tertiary: "#b5ebff",              // ice blue (info / waiting states)
  tertiaryContainer: "#84d1ec",
  onTertiary: "#003543",
  onTertiaryContainer: "#001f29",   // dark text on tertiaryContainer (cooldown banner)

  error: "#ffb4ab",                 // soft coral (error text)
  errorContainer: "#93000a",        // deep red bg
  onError: "#690005",
  onErrorContainer: "#ffdad6",

  // Brand-specific
  bitcoinOrange: "#F7931A",         // ₿ BTC logo accent (headers / nav active border)

  // Bull / Bear
  green: "#10b981",                 // emerald-500 (bull primary)
  green2: "#34d399",                // emerald-400 (bull lighter)
  red: "#ffb4ab",                   // alias for error (bear)
  red2: "#cf304a",

  // Legacy-ish aliases (back-compat with existing components — to be phased out)
  orange: "#ffb874",                // → primaryContainer
  orange2: "#F7931A",               // → bitcoinOrange
  yellow: "#ffb874",
  blue: "#3c7aea",                  // kept for chart EMA9 line
  purple: "#8b62ff",                // kept for chart EMA21 line
};

export const radius = {
  card: 2,    // rounded-sm = 2px (Material You sharp default)
  chip: 2,
  pill: 999,  // rounded-full for pills & status dots
  input: 2,
};

export const spacing = {
  cardPadding: 16,
  gap: 12,
  tight: 4,
};

export const typeSize = {
  micro: 9,
  caption: 10,
  small: 11,
  body: 12,
  emph: 13,
  h3: 14,
  h2: 16,
  h1: 22,
  display: 32,
};

export const letterSpace = {
  normal: 0,
  label: 0.3,
  tag: 0.5,
  caps: 1,
  wide: 2,     // tracking-widest (0.2em-ish for 10-11px text)
};

/** Font families (loaded via expo-font in App.tsx). Falls back to system. */
export const fonts = {
  headline: "SpaceGrotesk_700Bold",
  headlineMed: "SpaceGrotesk_500Medium",
  body: "Inter_400Regular",
  bodyBold: "Inter_700Bold",
  mono: "JetBrainsMono_500Medium",
  icon: "MaterialSymbolsOutlined",
};

/** Helper: color by +/- sign */
export const signColor = (n: number) => (n >= 0 ? P.green : P.error);

/** Semi-transparent helper (RN accepts "#RRGGBBAA") */
export const alpha = (hex: string, a: number) => {
  const aa = Math.round(a * 255).toString(16).padStart(2, "0");
  return hex + aa;
};
