import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      "**/*.integration.test.ts",
      "tests/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "coverage",
      // Everything else is a script, a schema declaration or a query module.
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        "src/schema.ts",
        "src/client.ts",
        "src/cli-entry.ts",
        "src/constants.ts",
        "src/runs.ts",
        "src/seed*.ts",
      ],
    },
  },
});
