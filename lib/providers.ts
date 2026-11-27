export const providers = ["vercel", "typesafe", "laya"] as const;
export type Provider = (typeof providers)[number];

export function resolveProvider(value: unknown): Provider {
  return value === "typesafe" || value === "laya" ? value : "vercel";
}

export function providerLabel(provider: Provider): string {
  return provider === "laya"
    ? "your Laya server"
    : provider === "typesafe"
      ? "TypeSafe AI"
      : "Vercel AI Gateway";
}

export function providerKeyLabel(provider: Provider): string {
  return provider === "laya"
    ? "Laya server"
    : provider === "typesafe"
      ? "TypeSafe / Jev"
      : "Vercel AI Gateway";
}

// Laya is self-hosted: the server URL is required, the key only when LAYA_API_KEY is set.
export function isConfigured(settings: { provider: Provider; apiKey: string; endpoint: string }) {
  return settings.provider === "laya" ? !!settings.endpoint : !!settings.apiKey;
}

export function layaEndpoint(base: string): string {
  const url = new URL(base.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Laya server URL must start with http:// or https://.");
  if (url.username || url.password)
    throw new Error("Put the Laya key in the key field, not the URL.");
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1\/systemone$/, "") + "/v1/systemone";
  return url.toString();
}

export function smokeCredentials(env: Record<string, string | undefined>): {
  provider: Provider;
  key: string;
  endpoint?: string;
} {
  const laya = env.LAYA_URL?.trim();
  if (laya) return { provider: "laya", key: env.LAYA_API_KEY?.trim() ?? "", endpoint: laya };
  const gateway = env.AI_GATEWAY_API_KEY?.trim();
  const jev = env.JEV_KEY?.trim();
  const typesafe = env.TYPESAFE_API_KEY?.trim();
  if (gateway && (jev || typesafe))
    throw new Error(
      "Set only one provider's credentials: JEV_KEY / TYPESAFE_API_KEY or AI_GATEWAY_API_KEY, not both.",
    );
  if (jev && typesafe && jev !== typesafe)
    throw new Error("JEV_KEY and TYPESAFE_API_KEY differ. Set only one TypeSafe key.");
  const direct = jev || typesafe;
  if (direct) return { provider: "typesafe", key: direct };
  if (gateway) return { provider: "vercel", key: gateway };
  throw new Error(
    "Set JEV_KEY or TYPESAFE_API_KEY for TypeSafe AI, AI_GATEWAY_API_KEY for Vercel, or LAYA_URL for a Laya server. Never pass keys as command-line arguments.",
  );
}
