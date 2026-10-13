export const providers = ["openrouter", "vercel", "typesafe"] as const;
export type Provider = (typeof providers)[number];

export function resolveProvider(value: unknown): Provider {
  return value === "typesafe" || value === "openrouter" ? value : "vercel";
}

export function providerLabel(provider: Provider): string {
  return provider === "typesafe"
    ? "TypeSafe AI"
    : provider === "openrouter"
      ? "OpenRouter (Jev)"
      : "Vercel AI Gateway";
}

export function providerKeyLabel(provider: Provider): string {
  return provider === "typesafe"
    ? "TypeSafe / Jev"
    : provider === "openrouter"
      ? "OpenRouter"
      : "Vercel AI Gateway";
}

export function smokeCredentials(env: Record<string, string | undefined>): {
  provider: Provider;
  key: string;
} {
  const gateway = env.AI_GATEWAY_API_KEY?.trim();
  const jev = env.JEV_KEY?.trim();
  const typesafe = env.TYPESAFE_API_KEY?.trim();
  const openrouter = env.OPENROUTER_API_KEY?.trim();
  if (gateway && (jev || typesafe))
    throw new Error(
      "Set only one provider's credentials: JEV_KEY / TYPESAFE_API_KEY or AI_GATEWAY_API_KEY, not both.",
    );
  if (openrouter && (gateway || jev || typesafe))
    throw new Error(
      "Set only one provider's credentials: OPENROUTER_API_KEY, JEV_KEY / TYPESAFE_API_KEY or AI_GATEWAY_API_KEY, not several.",
    );
  if (jev && typesafe && jev !== typesafe)
    throw new Error("JEV_KEY and TYPESAFE_API_KEY differ. Set only one TypeSafe key.");
  const direct = jev || typesafe;
  if (direct) return { provider: "typesafe", key: direct };
  if (openrouter) return { provider: "openrouter", key: openrouter };
  if (gateway) return { provider: "vercel", key: gateway };
  throw new Error(
    "Set JEV_KEY or TYPESAFE_API_KEY for TypeSafe AI, OPENROUTER_API_KEY for OpenRouter, or AI_GATEWAY_API_KEY for Vercel. Never pass keys as command-line arguments.",
  );
}
