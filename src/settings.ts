import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { CONFIG } from "./config.js";

const ENV_FILE = ".env";

export type Provider = "anthropic" | "openai" | "gemini";

export const PROVIDERS: Record<Provider, { label: string; keyEnv: string; models: string[] }> = {
  anthropic: {
    label: "Anthropic (Claude)",
    keyEnv: "ANTHROPIC_API_KEY",
    models: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
  },
  openai: {
    label: "OpenAI (GPT)",
    keyEnv: "OPENAI_API_KEY",
    models: ["gpt-5.1", "gpt-5", "gpt-5-mini", "gpt-4.1"],
  },
  gemini: {
    label: "Google (Gemini)",
    keyEnv: "GEMINI_API_KEY",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
  },
};

// Load .env into process.env at import time, before settings are initialised.
// Shell-exported variables take precedence over the file.
if (existsSync(ENV_FILE)) {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch (err) {
    console.warn(`[settings] failed to load ${ENV_FILE}: ${(err as Error).message}`);
  }
}

export interface TunerSettings {
  enabled: boolean;
  provider: Provider;
  model: string;
  intervalMs: number;
}

function envProvider(): Provider {
  const p = process.env.TUNER_PROVIDER;
  return p && p in PROVIDERS ? (p as Provider) : "anthropic";
}

export const tunerSettings: TunerSettings = {
  enabled: process.env.TUNER_ENABLED ? process.env.TUNER_ENABLED !== "false" : CONFIG.tuner.enabled,
  provider: envProvider(),
  model: process.env.TUNER_MODEL || CONFIG.tuner.model,
  intervalMs: Number(process.env.TUNER_INTERVAL_MS) || CONFIG.tuner.intervalMs,
};

export function hasTunerKey(): boolean {
  if (tunerSettings.provider === "anthropic" && process.env.ANTHROPIC_AUTH_TOKEN) return true;
  return !!process.env[PROVIDERS[tunerSettings.provider].keyEnv];
}

export interface SettingsPatch {
  enabled?: boolean;
  provider?: string;
  model?: string;
  intervalMs?: number;
  keys?: Partial<Record<Provider, string>>;
}

/** Apply a settings patch from the UI and persist everything to .env. */
export function updateSettings(patch: SettingsPatch): void {
  if (patch.provider !== undefined) {
    if (!(patch.provider in PROVIDERS)) throw new Error(`unknown provider: ${patch.provider}`);
    tunerSettings.provider = patch.provider as Provider;
  }
  if (patch.model !== undefined) {
    const model = patch.model.trim();
    if (!model) throw new Error("model must not be empty");
    tunerSettings.model = model;
  }
  if (patch.intervalMs !== undefined) {
    if (!Number.isFinite(patch.intervalMs) || patch.intervalMs < 60_000) {
      throw new Error("intervalMs must be at least 60000 (1 minute)");
    }
    tunerSettings.intervalMs = Math.round(patch.intervalMs);
  }
  if (patch.enabled !== undefined) tunerSettings.enabled = !!patch.enabled;

  const envUpdates: Record<string, string> = {
    TUNER_ENABLED: String(tunerSettings.enabled),
    TUNER_PROVIDER: tunerSettings.provider,
    TUNER_MODEL: tunerSettings.model,
    TUNER_INTERVAL_MS: String(tunerSettings.intervalMs),
  };
  for (const [provider, key] of Object.entries(patch.keys ?? {})) {
    if (!(provider in PROVIDERS)) throw new Error(`unknown provider: ${provider}`);
    const trimmed = (key ?? "").trim();
    if (!trimmed) continue; // empty input = keep existing key
    const envName = PROVIDERS[provider as Provider].keyEnv;
    process.env[envName] = trimmed;
    envUpdates[envName] = trimmed;
  }

  saveEnvFile(envUpdates);
}

/** Read-modify-write .env, preserving unmanaged lines and comments. */
function saveEnvFile(updates: Record<string, string>): void {
  let lines: string[] = [];
  if (existsSync(ENV_FILE)) {
    lines = readFileSync(ENV_FILE, "utf8").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
  }
  const remaining = { ...updates };
  lines = lines.map((line) => {
    const key = line.slice(0, line.indexOf("="));
    if (key && key in remaining) {
      const value = remaining[key];
      delete remaining[key];
      return `${key}=${value}`;
    }
    return line;
  });
  for (const [key, value] of Object.entries(remaining)) lines.push(`${key}=${value}`);

  const tmp = `${ENV_FILE}.tmp`;
  writeFileSync(tmp, lines.join("\n") + "\n", "utf8");
  renameSync(tmp, ENV_FILE);
}

/** Settings for the UI. Key values are never returned — only a masked hint. */
export function settingsView() {
  return {
    tuner: { ...tunerSettings },
    providers: (Object.keys(PROVIDERS) as Provider[]).map((id) => {
      const key = process.env[PROVIDERS[id].keyEnv];
      return {
        id,
        label: PROVIDERS[id].label,
        models: PROVIDERS[id].models,
        keyHint: key ? `…${key.slice(-4)}` : null,
      };
    }),
  };
}
