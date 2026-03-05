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
        bg: "#05080D",
        surface: "#0E1722",
        border: "#1A2B3D",
        "border-bright": "#2B4560",
        accent: "#2CE8C6",
        "accent-dim": "#1DB89A",
        danger: "#FF5F6D",
        "danger-dim": "#C74551",
        blue: "#4EA3FF",
        "blue-dim": "#3A7FCB",
        warning: "#FFB14A",
        text: "#E8F2FF",
        muted: "#94A9BE",
        "muted-dim": "#65798F",
        hash: "#8AB8FF",
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
          "0%": { boxShadow: "0 0 8px 0px rgba(44, 232, 198, 0.3)" },
          "100%": { boxShadow: "0 0 24px 4px rgba(44, 232, 198, 0.6)" },
        },
      },
    },
  },
  plugins: [],
};
export default config;
