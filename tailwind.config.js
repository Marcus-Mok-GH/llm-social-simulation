/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        void: {
          950: "#05070d",
          900: "#0a0e1a",
          800: "#111827",
          700: "#1b2436",
        },
        signal: {
          DEFAULT: "#38e1c8",
          dim: "#1f8f7f",
        },
        hazard: {
          DEFAULT: "#ffb020",
          dim: "#b47812",
        },
      },
      fontFamily: {
        display: ['"Orbitron"', "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "monospace"],
      },
      keyframes: {
        drift: {
          "0%": { transform: "translateY(0px)" },
          "100%": { transform: "translateY(-24px)" },
        },
        pulseGlow: {
          "0%, 100%": { opacity: "0.4" },
          "50%": { opacity: "0.9" },
        },
      },
      animation: {
        drift: "drift 6s ease-in-out infinite alternate",
        pulseGlow: "pulseGlow 3s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
