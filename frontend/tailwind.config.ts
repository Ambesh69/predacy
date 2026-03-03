import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: ["var(--font-mono)", "monospace"],
        display: ["var(--font-display)", "sans-serif"],
      },
      colors: {
        bg: "#03030A",
        surface: "#09090F",
        border: "#13131F",
        "border-bright": "#1E1E30",
        accent: "#00FFB3",
        "accent-dim": "#00C48A",
        danger: "#FF3355",
        "danger-dim": "#CC2244",
        blue: "#4D83FF",
        "blue-dim": "#2D5AE0",
        text: "#C8C8E0",
        muted: "#6B6B8A",      // readable secondary text (~4.5:1 on bg)
        "muted-dim": "#42425A", // decorative / purely ornamental elements
        hash: "#6B9FFF",
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "flicker": "flicker 4s linear infinite",
        "scan": "scan 8s linear infinite",
        "glow-accent": "glowAccent 2s ease-in-out infinite alternate",
        "slide-up": "slideUp 0.2s ease-out",
      },
      keyframes: {
        slideUp: {
          "0%":   { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        flicker: {
          "0%, 100%": { opacity: "1" },
          "92%": { opacity: "1" },
          "93%": { opacity: "0.4" },
          "94%": { opacity: "1" },
          "96%": { opacity: "0.6" },
          "97%": { opacity: "1" },
        },
        scan: {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100vh)" },
        },
        glowAccent: {
          "0%": { boxShadow: "0 0 8px 0px rgba(0, 255, 179, 0.3)" },
          "100%": { boxShadow: "0 0 24px 4px rgba(0, 255, 179, 0.6)" },
        },
      },
    },
  },
  plugins: [],
};
export default config;
