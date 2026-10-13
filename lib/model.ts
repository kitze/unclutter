import { z } from "zod";
import { isConfigured, type Provider } from "./providers";

export const POLICY_VERSION = 1;
export const ANALYSIS_VERSION = 2;
export const categories = [
  "keep",
  "ad",
  "promotion",
  "newsletter",
  "social",
  "cookie",
  "uncertain",
] as const;
export type Category = (typeof categories)[number];
export const ruleSchema = z.object({
  selector: z.string().min(1).max(400),
  category: z.enum(categories),
  enabled: z.boolean(),
});
export type Rule = z.infer<typeof ruleSchema>;
export const profileSchema = z.object({
  key: z.string(),
  label: z.string(),
  origin: z.string(),
  enabled: z.boolean(),
  version: z.number(),
  analysisVersion: z.number().default(1),
  analyzedAt: z.number(),
  candidateCount: z.number(),
  rules: z.array(ruleSchema).max(60),
});
export type Profile = z.infer<typeof profileSchema>;
export const contextSchema = z.object({
  key: z.string().max(200),
  label: z.string().max(200),
  origin: z.string().max(300),
  kind: z.enum(["home", "article", "product", "search", "listing", "page"]),
});
export type PageContext = z.infer<typeof contextSchema>;
export const candidateSchema = z.object({
  id: z.string().regex(/^e\d+$/),
  selector: z.string().min(1).max(400),
  tag: z.string().max(30),
  signals: z.string().max(300),
  text: z.string().max(450),
  position: z.string().max(30),
  count: z.number().int().min(1).max(20),
});
export type Candidate = z.infer<typeof candidateSchema>;
export const snapshotSchema = z.object({
  context: contextSchema,
  candidates: z.array(candidateSchema).max(60),
  url: z.string().max(4000),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export type PageState = {
  context: PageContext;
  profile: Profile | null;
  enabled: boolean;
  hiddenCount: number;
};
export type Settings = {
  enabled: boolean;
  apiKey: string;
  provider: Provider;
  endpoint: string;
  mode: "manual" | "auto";
};
export function shouldAutoAnalyze(
  settings: Settings,
  profile: Profile | null,
  attempted: boolean,
): boolean {
  return (
    settings.enabled &&
    settings.mode === "auto" &&
    isConfigured(settings) &&
    !attempted &&
    (!profile || (profile.enabled && profile.analysisVersion < ANALYSIS_VERSION))
  );
}
export type Reply<T> = { ok: true; data: T } | { ok: false; error: string };
export function unwrap<T>(reply: Reply<T>): T {
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}

export function hash(value: string): string {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 16777619);
  return (result >>> 0).toString(36);
}
