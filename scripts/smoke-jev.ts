import { evaluate } from "../lib/jev";
import type { Snapshot } from "../lib/model";
import { providerLabel, smokeCredentials } from "../lib/providers";

const { provider, key, endpoint } = smokeCredentials(process.env);
const snapshot: Snapshot = {
  url: "https://example.com/article/synthetic",
  context: { key: "synthetic", kind: "article", label: "article", origin: "https://example.com" },
  candidates: [
    {
      id: "e0",
      selector: "div.ad-banner",
      tag: "div",
      signals: "advertisement sponsored ad-banner",
      text: "Advertisement: save 30% on unrelated travel packages.",
      position: "static",
      count: 1,
    },
    {
      id: "e1",
      selector: "aside.article-context",
      tag: "aside",
      signals: "article-context",
      text: "Background: the scientific methods and sources used for this news article.",
      position: "static",
      count: 1,
    },
    {
      id: "e2",
      selector: 'div[id^="sp_message_container_"]',
      tag: "div",
      signals: "Cookie consent overlay sp_message_container_123456",
      text: "We value your privacy. Accept all cookies or manage your preferences.",
      position: "fixed",
      count: 1,
    },
    {
      id: "e3",
      selector: 'div[data-testid="ad-unit"]',
      tag: "div",
      signals: "ad-unit ad-slot reserved advertisement space min-height 300px",
      text: "",
      position: "static",
      count: 1,
    },
  ],
};
const start = performance.now();
const rules = await evaluate(snapshot, key, provider, endpoint);
if (!rules.some((rule) => rule.selector === "div.ad-banner"))
  throw new Error("Synthetic ad was not selected.");
if (rules.some((rule) => rule.selector === "aside.article-context"))
  throw new Error("Editorial context was incorrectly selected.");
if (
  !rules.some(
    (rule) => rule.category === "cookie" && rule.selector === 'div[id^="sp_message_container_"]',
  )
)
  throw new Error("Cookie dialog was not selected.");
if (!rules.some((rule) => rule.selector === 'div[data-testid="ad-unit"]'))
  throw new Error("Empty ad wrapper was not selected.");
console.log(
  `PASS: live ${provider === "laya" ? "Laya" : "Jev"} via ${providerLabel(provider)} selected ad, cookie dialog and empty ad wrapper; kept editorial context (${Math.round(performance.now() - start)} ms).`,
);
