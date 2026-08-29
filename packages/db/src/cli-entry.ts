import { pathToFileURL } from "node:url";

// process.argv[1] is undefined outside a CLI run: without the guard, importing a script
// from a test would auto-run it or throw in pathToFileURL(undefined).
export function isMain(moduleUrl: string): boolean {
  return (
    process.argv[1] !== undefined &&
    moduleUrl === pathToFileURL(process.argv[1]).href
  );
}
