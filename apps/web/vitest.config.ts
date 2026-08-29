import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "coverage",
      // Only what the unit suite owns: the query modules are SQL, utils.ts is shadcn's
      // cn(). The four use-* hooks report 0% — that gap is real.
      include: ["lib/**/*.ts"],
      exclude: ["lib/queries.ts", "lib/queries-metrics.ts", "lib/utils.ts"],
    },
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["**/*.test.ts"],
          exclude: [
            ...configDefaults.exclude,
            "**/*.integration.test.ts",
            "tests/**",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: ["**/*.test.tsx"],
          setupFiles: ["./vitest.setup.tsx"],
        },
      },
    ],
  },
});
