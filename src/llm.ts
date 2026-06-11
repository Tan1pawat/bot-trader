import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { StrategyParams } from "./config.js";
import { PROVIDERS, type Provider } from "./settings.js";

const PARAM_DESCRIPTIONS: Record<keyof StrategyParams, string> = {
  maxPositions: "Max concurrent positions",
  positionSizePctOfEquity: "Fraction of equity per trade, e.g. 0.2 = 20%",
  entryMomentumPct: "Min % move over momentumWindowSec to enter",
  momentumWindowSec: "Momentum lookback window in seconds",
  confirmWindowSec: "Short confirmation window in seconds (must also be rising)",
  takeProfitPct: "Exit when position is up this %",
  stopLossPct: "Exit when position is down this % (positive number)",
  trailingArmPct: "Arm the trailing stop once up this %",
  trailingGivebackPct: "Exit if price falls this % from the high once armed",
  timeStopMin: "Exit stale positions after this many minutes",
  timeStopMinPnlPct: "...unless P&L is at least this %",
  cooldownAfterExitMin: "Per-token re-entry cooldown in minutes",
};

const RATIONALE_DESCRIPTION =
  "2-4 sentences: what the trading log showed and why these changes (or no changes) follow from it";

export const TunerOutput = z.object({
  maxPositions: z.number().describe(PARAM_DESCRIPTIONS.maxPositions),
  positionSizePctOfEquity: z.number().describe(PARAM_DESCRIPTIONS.positionSizePctOfEquity),
  entryMomentumPct: z.number().describe(PARAM_DESCRIPTIONS.entryMomentumPct),
  momentumWindowSec: z.number().describe(PARAM_DESCRIPTIONS.momentumWindowSec),
  confirmWindowSec: z.number().describe(PARAM_DESCRIPTIONS.confirmWindowSec),
  takeProfitPct: z.number().describe(PARAM_DESCRIPTIONS.takeProfitPct),
  stopLossPct: z.number().describe(PARAM_DESCRIPTIONS.stopLossPct),
  trailingArmPct: z.number().describe(PARAM_DESCRIPTIONS.trailingArmPct),
  trailingGivebackPct: z.number().describe(PARAM_DESCRIPTIONS.trailingGivebackPct),
  timeStopMin: z.number().describe(PARAM_DESCRIPTIONS.timeStopMin),
  timeStopMinPnlPct: z.number().describe(PARAM_DESCRIPTIONS.timeStopMinPnlPct),
  cooldownAfterExitMin: z.number().describe(PARAM_DESCRIPTIONS.cooldownAfterExitMin),
  rationale: z.string().describe(RATIONALE_DESCRIPTION),
});
export type TunerOutputT = z.infer<typeof TunerOutput>;

// Plain JSON schema equivalents of TunerOutput, for the non-Anthropic providers.
const JSON_SCHEMA_PROPERTIES = {
  ...Object.fromEntries(
    Object.entries(PARAM_DESCRIPTIONS).map(([k, description]) => [k, { type: "number", description }]),
  ),
  rationale: { type: "string", description: RATIONALE_DESCRIPTION },
};
const TUNER_JSON_SCHEMA = {
  type: "object",
  properties: JSON_SCHEMA_PROPERTIES,
  required: Object.keys(JSON_SCHEMA_PROPERTIES),
  additionalProperties: false,
};
const GEMINI_SCHEMA = {
  type: "OBJECT",
  properties: Object.fromEntries(
    Object.entries(JSON_SCHEMA_PROPERTIES).map(([k, v]) => [k, { type: v.type.toUpperCase(), description: v.description }]),
  ),
  required: Object.keys(JSON_SCHEMA_PROPERTIES),
};

const TIMEOUT_MS = 120_000;

/** Call the configured provider; returns the raw parsed JSON object (validated by the caller). */
export async function callTuner(provider: Provider, model: string, system: string, user: string): Promise<unknown> {
  switch (provider) {
    case "anthropic":
      return callAnthropic(model, system, user);
    case "openai":
      return callOpenAI(model, system, user);
    case "gemini":
      return callGemini(model, system, user);
  }
}

async function callAnthropic(model: string, system: string, user: string): Promise<unknown> {
  // Fresh client per call so keys changed via the settings UI take effect.
  const client = new Anthropic();
  // Adaptive thinking is only accepted on Opus 4.6+, Sonnet 4.6, and Fable/Mythos.
  const adaptive = /opus-4-[678]|sonnet-4-6|fable|mythos/.test(model);
  const response = await client.messages.parse({
    model,
    max_tokens: 16000,
    ...(adaptive ? { thinking: { type: "adaptive" as const } } : {}),
    system,
    messages: [{ role: "user", content: user }],
    output_config: { format: zodOutputFormat(TunerOutput) },
  });
  if (response.stop_reason === "refusal" || response.parsed_output == null) {
    throw new Error(`Anthropic: no usable response (stop_reason: ${response.stop_reason})`);
  }
  return response.parsed_output;
}

async function callOpenAI(model: string, system: string, user: string): Promise<unknown> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env[PROVIDERS.openai.keyEnv]}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "tuner_output", strict: true, schema: TUNER_JSON_SCHEMA },
      },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string; refusal?: string } }[] };
  const message = data.choices?.[0]?.message;
  if (message?.refusal) throw new Error(`OpenAI refusal: ${message.refusal}`);
  if (!message?.content) throw new Error("OpenAI: empty response");
  return JSON.parse(message.content);
}

async function callGemini(model: string, system: string, user: string): Promise<unknown> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": process.env[PROVIDERS.gemini.keyEnv] ?? "",
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: GEMINI_SCHEMA },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
  if (!text) throw new Error("Gemini: empty response");
  return JSON.parse(text);
}
