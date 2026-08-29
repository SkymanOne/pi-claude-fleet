/**
 * A worker spawned with a model pi does not have dies a minute later, after a
 * worktree and a branch exist, with the reason buried in its state file. The
 * names are cheap to ask for, so a spawn checks first and says what is there.
 */
import { execFile } from "node:child_process";
import { piCommand } from "./monitor.js";

/** How long the listing may take before the check gives up and allows the spawn. */
const LIST_TIMEOUT_MS = 10_000;

let cached: string[] | null = null;

/** Model names pi reports, or an empty list when it cannot be asked. */
export async function availableModels(): Promise<string[]> {
  if (cached) return cached;
  const { bin, prefix } = piCommand();
  const models = await new Promise<string[]>((resolve) => {
    execFile(bin, [...prefix, "--list-models"], { timeout: LIST_TIMEOUT_MS, maxBuffer: 8 << 20 }, (error, stdout) => {
      if (error && !stdout) return resolve([]);
      const names = new Set<string>();
      for (const line of stdout.split("\n").slice(1)) {
        // "provider  model  context  max-out  thinking  images"
        const columns = line.trim().split(/\s{2,}|\t|\s+/).filter((c) => c.length > 0);
        if (columns.length >= 2) names.add(columns[1]);
      }
      resolve([...names]);
    });
  });
  if (models.length > 0) cached = models;
  return models;
}

/**
 * Null when the model is fine or cannot be checked; otherwise a message naming
 * the closest models, so the caller can pick one straight away.
 */
export async function checkModel(model: string | null | undefined): Promise<string | null> {
  if (!model) return null;
  const models = await availableModels();
  // an empty listing means pi could not be asked, which is not the user's problem
  if (models.length === 0 || models.includes(model)) return null;
  const near = closest(model, models);
  const suffix = near.length > 0 ? `; did you mean ${near.join(", ")}?` : "";
  return `unknown model "${model}"${suffix} (pi --list-models shows all ${models.length})`;
}

/** Models whose name contains, or is contained by, what was asked for. */
function closest(model: string, models: string[]): string[] {
  const wanted = model.toLowerCase();
  const scored = models
    .filter((m) => {
      const name = m.toLowerCase();
      return name.includes(wanted) || wanted.includes(name) || sharesStem(name, wanted);
    })
    .sort((a, b) => Math.abs(a.length - model.length) - Math.abs(b.length - model.length));
  return scored.slice(0, 3);
}

/** "glm-5.3-max" and "glm-5.3" share a stem; "glm-5.3-max" and "gpt-6" do not. */
function sharesStem(a: string, b: string): boolean {
  const stem = (s: string): string => s.split(/[-/]/).slice(0, 2).join("-");
  return stem(a) === stem(b);
}

/** Test seam: forget the listing so a later spawn asks again. */
export function resetModelCache(): void {
  cached = null;
}
