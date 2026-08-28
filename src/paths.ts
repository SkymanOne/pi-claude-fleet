import path from "node:path";
import { fileURLToPath } from "node:url";

/** `src/` in development (tsx), `dist/` when built. */
export const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.dirname(SRC_DIR);
export const FLEET_EXTENSION_PATH = path.join(PACKAGE_ROOT, "pi", "extensions", "fleet-report.ts");
export const FLEET_SKILL_PATH = path.join(PACKAGE_ROOT, "pi", "skills", "fleet-worker-report");
export const CLAUDE_SKILL_SOURCE = path.join(PACKAGE_ROOT, "claude", "skills", "pi-orchestrator");
