import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "tests/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "coverage",
      // loaders.ts talks to the database; index.ts and chat-ui.ts only re-export.
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/chat-ui.ts", "src/loaders.ts"],
    },
  },
});
