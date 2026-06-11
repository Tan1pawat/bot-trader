import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CONFIG } from "./config.js";
import { freshState } from "./engine.js";
import type { EngineState } from "./types.js";

export async function loadState(): Promise<EngineState> {
  try {
    const raw = await readFile(CONFIG.dataFile, "utf8");
    const state = JSON.parse(raw) as EngineState;
    console.log(`[store] resumed state: $${state.cashUsd.toFixed(2)} cash, ${state.positions.length} open positions, ${state.trades.length} trades`);
    return state;
  } catch {
    console.log(`[store] starting fresh with $${CONFIG.startingBalanceUsd}`);
    return freshState();
  }
}

export async function saveState(state: EngineState): Promise<void> {
  await mkdir(dirname(CONFIG.dataFile), { recursive: true });
  const tmp = `${CONFIG.dataFile}.tmp`;
  await writeFile(tmp, JSON.stringify(state), "utf8");
  await rename(tmp, CONFIG.dataFile);
}
