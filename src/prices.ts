import { WATCHLIST } from "./config.js";

export type PriceMap = Map<string, number>; // mint -> USD price

const JUPITER_URL = "https://lite-api.jup.ag/price/v3";
const DEXSCREENER_URL = "https://api.dexscreener.com/tokens/v1/solana";

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function fromJupiter(mints: string[]): Promise<PriceMap> {
  const data = await fetchJson(`${JUPITER_URL}?ids=${mints.join(",")}`);
  const prices: PriceMap = new Map();
  for (const mint of mints) {
    const entry = data[mint];
    if (entry && typeof entry.usdPrice === "number" && entry.usdPrice > 0) {
      prices.set(mint, entry.usdPrice);
    }
  }
  return prices;
}

async function fromDexScreener(mints: string[]): Promise<PriceMap> {
  const data = await fetchJson(`${DEXSCREENER_URL}/${mints.join(",")}`);
  const prices: PriceMap = new Map();
  // Returns an array of pairs; keep the most liquid pair per base token.
  const bestLiq: Map<string, number> = new Map();
  for (const pair of Array.isArray(data) ? data : []) {
    const mint = pair?.baseToken?.address;
    const price = Number(pair?.priceUsd);
    const liq = Number(pair?.liquidity?.usd ?? 0);
    if (!mint || !mints.includes(mint) || !(price > 0)) continue;
    if (liq > (bestLiq.get(mint) ?? -1)) {
      bestLiq.set(mint, liq);
      prices.set(mint, price);
    }
  }
  return prices;
}

export async function fetchPrices(): Promise<PriceMap> {
  const mints = WATCHLIST.map((t) => t.mint);
  try {
    const prices = await fromJupiter(mints);
    if (prices.size > 0) return prices;
    throw new Error("Jupiter returned no prices");
  } catch (err) {
    console.warn(`[prices] Jupiter failed (${(err as Error).message}), trying DexScreener`);
    return fromDexScreener(mints);
  }
}
