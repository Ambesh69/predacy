import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Enable inline tests written inside `if (import.meta.vitest)` blocks
    includeSource: ["src/**/*.ts"],
    // Exclude compiled output and node_modules
    exclude: ["node_modules", "dist"],
  },
});
