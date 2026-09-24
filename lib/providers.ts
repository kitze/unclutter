export const providers = ["vercel", "typesafe", "openrouter"] as const;
export type Provider = (typeof providers)[number];

export function resolveProvider(value: unknown): Provider {
  return value === "typesafe" || value === "openrouter" ? value : "vercel";
}

export function providerLabel(provider: Provider): string {
  return provider === "typesafe"
    ? "TypeSafe AI"
    : provider === "openrouter"
      ? "OpenRouter"
      : "Vercel AI Gateway";
}

export function providerKeyLabel(provider: Provider): string {
  return provider === "typesafe"
    ? "TypeSafe / Jev"
    : provider === "openrouter"
      ? "OpenRouter"
      : "Vercel AI Gateway";
}

export function providerShortLabel(provider: Provider): string {
  return provider === "typesafe" ? "TypeSafe" : provider === "openrouter" ? "OpenRouter" : "Vercel";
}

export function smokeCredentials(env: Record<string, string | undefined>): {
  provider: Provider;
  key: string;
} {
  const gateway = env.AI_GATEWAY_API_KEY?.trim();
  const openrouter = env.OPENROUTER_API_KEY?.trim();
  const jev = env.JEV_KEY?.trim();
  const typesafe = env.TYPESAFE_API_KEY?.trim();
  if ([gateway, openrouter, jev || typesafe].filter(Boolean).length > 1)
    throw new Error(
      "Set only one provider's credentials: JEV_KEY / TYPESAFE_API_KEY, AI_GATEWAY_API_KEY or OPENROUTER_API_KEY.",
    );
  if (jev && typesafe && jev !== typesafe)
    throw new Error("JEV_KEY and TYPESAFE_API_KEY differ. Set only one TypeSafe key.");
  const direct = jev || typesafe;
  if (direct) return { provider: "typesafe", key: direct };
  if (gateway) return { provider: "vercel", key: gateway };
  if (openrouter) return { provider: "openrouter", key: openrouter };
  throw new Error(
    "Set JEV_KEY or TYPESAFE_API_KEY for TypeSafe AI, AI_GATEWAY_API_KEY for Vercel, or OPENROUTER_API_KEY for OpenRouter. Never pass keys as command-line arguments.",
  );
}
