import type { Config } from "tailwindcss";

/**
 * Light, technical theme modeled on tinycloud.xyz: paper background, slate text,
 * a single blue accent (#2563eb), Oswald display headings + Inter body, and a
 * terminal/window-chrome motif. Tailwind's default `slate`, `blue`, `red`,
 * `amber` scales are kept; we add only what's distinctive.
 */
const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        paper: "#f4f6f8", // tinycloud.xyz body background
        card: "#ffffff",
        // macOS traffic-light dots for the window-chrome motif
        win: { red: "#ff5f57", yellow: "#febc2e", green: "#28c840" },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["var(--font-oswald)", "var(--font-inter)", "ui-sans-serif", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      letterSpacing: {
        display: "0.02em",
      },
      boxShadow: {
        card: "0 1px 2px rgba(15,23,42,0.04), 0 10px 30px -18px rgba(15,23,42,0.18)",
        glow: "0 0 0 1px rgba(37,99,235,0.18), 0 14px 40px -16px rgba(37,99,235,0.30)",
      },
      backgroundImage: {
        grid: "linear-gradient(rgba(15,23,42,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(15,23,42,0.035) 1px, transparent 1px)",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: { "100%": { transform: "translateX(100%)" } },
      },
      animation: {
        "fade-in": "fade-in 0.3s ease-out",
        shimmer: "shimmer 1.5s infinite",
      },
    },
  },
  plugins: [],
};

export default config;
