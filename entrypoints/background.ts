import { browser } from "wxt/browser";
import { z } from "zod";
import { evaluate } from "../lib/jev";
import {
  isConfigured,
  layaEndpoint,
  providers,
  providerKeyLabel,
  resolveProvider,
} from "../lib/providers";
import {
  contextSchema,
  POLICY_VERSION,
  ANALYSIS_VERSION,
  shouldAutoAnalyze,
  profileSchema,
  snapshotSchema,
  unwrap,
  type PageContext,
  type PageState,
  type Profile,
  type Reply,
  type Settings,
  type Snapshot,
} from "../lib/model";

const uiMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("settings") }),
  z.object({
    type: z.literal("saveKey"),
    key: z.string().trim().min(1).max(1000),
    provider: z.enum(providers),
  }),
  z.object({
    type: z.literal("saveLaya"),
    endpoint: z.string().trim().min(1).max(500),
    key: z.string().trim().max(1000),
  }),
  z.object({ type: z.literal("provider"), provider: z.enum(providers) }),
  z.object({ type: z.literal("removeKey") }),
  z.object({ type: z.literal("global"), enabled: z.boolean() }),
  z.object({ type: z.literal("mode"), mode: z.enum(["manual", "auto"]) }),
  z.object({ type: z.literal("status"), tabId: z.number().int() }),
  z.object({ type: z.literal("analyze"), tabId: z.number().int() }),
  z.object({ type: z.literal("toggle"), tabId: z.number().int(), enabled: z.boolean() }),
  z.object({
    type: z.literal("rule"),
    tabId: z.number().int(),
    selector: z.string().max(400),
    enabled: z.boolean(),
  }),
  z.object({ type: z.literal("forget"), tabId: z.number().int() }),
]);
const pageMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("sync"),
    context: contextSchema,
    hiddenCount: z.number().int().min(0).max(1200),
  }),
  z.object({ type: z.literal("visit"), context: contextSchema }),
]);
const profileKey = (key: string) => `profile:${key}`;

export default defineBackground(() => {
  const action = browser.action ?? browser.browserAction;
  const jobs = new Map<string, Promise<void>>();
  const tabJobs = new Set<number>();
  const tabErrors = new Map<number, string>();
  // Chrome restricts storage to trusted extension contexts. Firefox lacks this
  // API; content code still never reads storage or receives credentials.
  void browser.storage.local
    .setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })
    .catch(() => undefined);
  const settings = async (): Promise<Settings> => {
    const data = await browser.storage.local.get([
      "enabled",
      "apiKey",
      "mode",
      "provider",
      "layaEndpoint",
      "layaKey",
    ]);
    const provider = resolveProvider(data.provider);
    // Laya keeps its own key so a hosted-provider key is never sent to a self-hosted server.
    const key = provider === "laya" ? data.layaKey : data.apiKey;
    return {
      enabled: data.enabled !== false,
      apiKey: typeof key === "string" ? key : "",
      provider,
      endpoint: typeof data.layaEndpoint === "string" ? data.layaEndpoint : "",
      mode: data.mode === "auto" ? "auto" : "manual",
    };
  };
  const profile = async (context: PageContext): Promise<Profile | null> => {
    const key = profileKey(context.key);
    const parsed = profileSchema.safeParse((await browser.storage.local.get(key))[key]);
    return parsed.success &&
      parsed.data.version === POLICY_VERSION &&
      parsed.data.origin === context.origin
      ? parsed.data
      : null;
  };
  const badge = async (tabId: number, state?: PageState, error = false) => {
    const busy = tabJobs.has(tabId);
    const paused = state && (!state.enabled || state.profile?.enabled === false);
    const saved = !!state?.profile;
    const text = error ? "!" : busy ? "…" : paused ? "OFF" : saved ? "ON" : "";
    const color = error ? "#c2413a" : busy ? "#ad6a11" : paused ? "#71717a" : "#187b61";
    const title = error
      ? "Unclutter: analysis failed — open popup"
      : busy
        ? "Unclutter: analyzing"
        : paused
          ? "Unclutter: paused"
          : saved
            ? `Unclutter: saved template · ${state.hiddenCount} hidden`
            : "Unclutter: not analyzed";
    await Promise.all([
      action.setBadgeText({ tabId, text }),
      action.setBadgeBackgroundColor({ tabId, color }),
      action.setTitle({ tabId, title }),
    ]);
  };
  const send = async <T>(tabId: number, type: string): Promise<T> => {
    try {
      return unwrap((await browser.tabs.sendMessage(tabId, { type }, { frameId: 0 })) as Reply<T>);
    } catch {
      throw new Error(
        "Page unavailable. Refresh this tab after installing. Browser pages, stores, PDFs and file URLs are not supported.",
      );
    }
  };
  const refresh = async (tabId: number) => send<PageState>(tabId, "refresh");
  const broadcast = async () => {
    const tabs = await browser.tabs.query({});
    await Promise.all(
      tabs
        .filter((tab) => tab.id !== undefined)
        .map((tab) => refresh(tab.id!).catch(() => undefined)),
    );
  };
  const analyze = async (tabId: number, automatic = false) => {
    const snapshot = snapshotSchema.parse(await send<Snapshot>(tabId, "snapshot"));
    const existing = jobs.get(snapshot.context.key);
    if (existing) {
      await existing;
      await refresh(tabId);
      return;
    }
    const attemptKey = `auto:${snapshot.context.key}:a${ANALYSIS_VERSION}`;
    const task = (async () => {
      const config = await settings();
      const before = await profile(snapshot.context);
      const attempt = (await browser.storage.local.get(attemptKey))[attemptKey];
      if (automatic && !shouldAutoAnalyze(config, before, !!attempt)) return;
      if (!isConfigured(config))
        throw new Error(
          config.provider === "laya"
            ? "Add your Laya server URL first."
            : `Add your ${providerKeyLabel(config.provider)} API key first.`,
        );
      if (!config.enabled) throw new Error("Enable Unclutter before analyzing.");
      tabJobs.add(tabId);
      tabErrors.delete(tabId);
      // Persist BEFORE making a paid request: a failed call or worker restart
      // must not create a retry loop across navigation or another tab.
      await browser.storage.local.set({ [attemptKey]: { startedAt: Date.now(), error: null } });
      await badge(tabId);
      const rules = await evaluate(snapshot, config.apiKey, config.provider, config.endpoint);
      const latestConfig = await settings();
      if (!latestConfig.enabled || (automatic && latestConfig.mode !== "auto")) return;
      const current = snapshotSchema.parse(await send<Snapshot>(tabId, "snapshot"));
      if (current.url !== snapshot.url || current.context.key !== snapshot.context.key)
        throw new Error("Page changed during analysis. Result discarded.");
      const latest = await profile(snapshot.context);
      if (JSON.stringify(latest) !== JSON.stringify(before))
        throw new Error("Rules changed during analysis. Your edits were kept; retry if needed.");
      // Preserve individual keep-visible choices when re-evaluating a template.
      for (const rule of rules)
        if (before?.rules.some((old) => old.selector === rule.selector && !old.enabled))
          rule.enabled = false;
      const next: Profile = {
        ...snapshot.context,
        enabled: before?.enabled ?? true,
        version: POLICY_VERSION,
        analysisVersion: ANALYSIS_VERSION,
        analyzedAt: Date.now(),
        candidateCount: snapshot.candidates.length,
        rules,
      };
      await browser.storage.local.set({ [profileKey(next.key)]: next });
      await browser.storage.local.remove(attemptKey);
    })();
    jobs.set(snapshot.context.key, task);
    try {
      await task;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Analysis failed.";
      tabErrors.set(tabId, message);
      await browser.storage.local.set({ [attemptKey]: { startedAt: Date.now(), error: message } });
      throw error;
    } finally {
      jobs.delete(snapshot.context.key);
      tabJobs.delete(tabId);
      await broadcast();
      if (tabErrors.has(tabId)) await badge(tabId, undefined, true);
    }
  };

  browser.tabs.onRemoved.addListener((tabId) => {
    tabJobs.delete(tabId);
    tabErrors.delete(tabId);
  });
  browser.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === "loading") {
      tabErrors.delete(tabId);
      void badge(tabId).catch(() => undefined);
    }
  });

  browser.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    const handle = async (): Promise<unknown> => {
      if (sender.id !== browser.runtime.id) throw new Error("Untrusted sender.");
      if (sender.tab) {
        const message = pageMessage.parse(raw);
        if (
          sender.frameId !== 0 ||
          sender.tab.id === undefined ||
          !sender.url ||
          new URL(sender.url).origin !== message.context.origin ||
          !message.context.key.startsWith(`${message.context.origin}|v${POLICY_VERSION}|`)
        )
          throw new Error("Invalid page context.");
        if (message.type === "visit") {
          await analyze(sender.tab.id, true);
          return null;
        }
        const config = await settings();
        const saved = await profile(message.context);
        const state: PageState = {
          context: message.context,
          profile: saved,
          enabled: config.enabled,
          hiddenCount: message.hiddenCount,
        };
        await badge(sender.tab.id, state, tabErrors.has(sender.tab.id));
        return {
          profile: saved,
          enabled: config.enabled,
          autoEnabled: config.mode === "auto" && isConfigured(config),
        };
      }
      if (sender.url !== browser.runtime.getURL("/popup.html"))
        throw new Error("Popup access required.");
      const message = uiMessage.parse(raw);
      if (message.type === "settings") {
        const config = await settings();
        return {
          enabled: config.enabled,
          hasKey: isConfigured(config),
          provider: config.provider,
          endpoint: config.endpoint,
          mode: config.mode,
        };
      }
      if (message.type === "saveKey") {
        await browser.storage.local.set({ apiKey: message.key, provider: message.provider });
        return null;
      }
      if (message.type === "saveLaya") {
        layaEndpoint(message.endpoint);
        await browser.storage.local.set({
          layaEndpoint: message.endpoint,
          layaKey: message.key,
          provider: "laya",
        });
        return null;
      }
      if (message.type === "provider") {
        await browser.storage.local.set({ provider: message.provider });
        return null;
      }
      if (message.type === "removeKey") {
        const { provider } = await settings();
        await browser.storage.local.remove(
          provider === "laya" ? ["layaEndpoint", "layaKey"] : "apiKey",
        );
        return null;
      }
      if (message.type === "global") {
        await browser.storage.local.set({ enabled: message.enabled });
        await broadcast();
        return null;
      }
      if (message.type === "mode") {
        await browser.storage.local.set({ mode: message.mode });
        await broadcast();
        return null;
      }
      if (message.type === "status") {
        const state = await send<PageState>(message.tabId, "state");
        const attemptKey = `auto:${state.context.key}:a${ANALYSIS_VERSION}`;
        const attempt = (await browser.storage.local.get(attemptKey))[attemptKey] as
          | { error?: string | null }
          | undefined;
        return {
          ...state,
          busy: tabJobs.has(message.tabId) || jobs.has(state.context.key),
          error: tabErrors.get(message.tabId) ?? attempt?.error ?? null,
        };
      }
      if (message.type === "analyze") {
        await analyze(message.tabId);
        return null;
      }
      const snapshot = snapshotSchema.parse(await send<Snapshot>(message.tabId, "snapshot"));
      const saved = await profile(snapshot.context);
      if (!saved) throw new Error("Analyze this page type first.");
      if (message.type === "forget") await browser.storage.local.remove(profileKey(saved.key));
      else {
        if (message.type === "toggle") saved.enabled = message.enabled;
        if (message.type === "rule") {
          const rule = saved.rules.find((r) => r.selector === message.selector);
          if (!rule) throw new Error("Rule not found.");
          rule.enabled = message.enabled;
        }
        await browser.storage.local.set({ [profileKey(saved.key)]: saved });
      }
      tabErrors.delete(message.tabId);
      await broadcast();
      return null;
    };
    void handle().then(
      (data) => sendResponse({ ok: true, data }),
      (error) =>
        sendResponse({
          ok: false,
          error:
            error instanceof z.ZodError
              ? "Invalid data received. Nothing changed."
              : error instanceof Error
                ? error.message
                : "Unexpected extension error.",
        }),
    );
    return true;
  });
});
