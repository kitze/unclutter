import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  collectCandidates,
  cookieEvidence,
  createCleaner,
  matchingElements,
  uncoveredConsent,
} from "../lib/dom";
import {
  ANALYSIS_VERSION,
  profileSchema,
  shouldAutoAnalyze,
  shouldRecheckConsent,
  type Settings,
} from "../lib/model";

const doc = (html: string) => new JSDOM(html).window.document;

test("Sourcepoint numeric IDs become reusable cookie selectors, including late DOM nodes", () => {
  const d = doc(
    "<main><h1>BBC</h1></main>" +
      "<div></div>".repeat(6100) +
      '<div id="sp_message_container_123456"><iframe id="sp_message_iframe_123456" title="Privacy consent"></iframe></div>',
  );
  const candidates = collectCandidates(d);
  assert.ok(candidates.some((c) => c.selector === 'div[id^="sp_message_container_"]'));
  assert.match(candidates[0]!.signals, /cookie consent/i);
  d.querySelector('[id^="sp_message_container_"]')!.id = "sp_message_container_999999";
  assert.equal(matchingElements(d, 'div[id^="sp_message_container_"]').length, 1);
  assert.equal(matchingElements(d, 'div[id^="sp_"]').length, 0);
});

test("cookie checkbox forms/headings can hide, without clicking or writing consent", () => {
  const d = doc(
    '<main>Article</main><div id="ngasCookiePrompt" role="dialog"><h1>Cookies</h1><form><input type="checkbox" checked><button>Accept all cookies</button></form></div>',
  );
  let clicked = false;
  d.querySelector("button")!.addEventListener("click", () => {
    clicked = true;
  });
  assert.ok(collectCandidates(d).some((c) => c.selector === "div#ngasCookiePrompt"));
  const cleaner = createCleaner(d);
  cleaner.apply([{ selector: "div#ngasCookiePrompt", category: "cookie", enabled: true }]);
  assert.equal((d.querySelector("#ngasCookiePrompt") as HTMLElement).style.display, "none");
  assert.equal(clicked, false);
  assert.equal((d.querySelector("input") as HTMLInputElement).checked, true);
  assert.equal(d.cookie, "");
  cleaner.restore();
  assert.equal((d.querySelector("#ngasCookiePrompt") as HTMLElement).style.display, "");
  const password = d.createElement("input");
  password.type = "password";
  d.querySelector("#ngasCookiePrompt")!.append(password);
  assert.equal(matchingElements(d, "div#ngasCookiePrompt").length, 0);
});

test("ad removal collapses empty fixed-height wrappers and label but preserves useful siblings", () => {
  const d = doc(
    '<main><h1>News</h1><div id="outer"><section id="slot" style="min-height:300px;padding:40px"><span>Advertisement</span><div class="ad-banner" style="display:block!important">Ad</div></section><p id="story">Real story</p></div></main>',
  );
  const cleaner = createCleaner(d);
  const rule = { selector: "div.ad-banner", category: "ad" as const, enabled: true };
  assert.equal(cleaner.apply([rule]), 1);
  assert.equal((d.querySelector("#slot") as HTMLElement).style.display, "none");
  assert.equal((d.querySelector("#outer") as HTMLElement).style.display, "");
  assert.equal((d.querySelector(".ad-banner") as HTMLElement).style.display, "none");
  // New useful content must uncollapse the wrapper even while it is hidden.
  const useful = d.createElement("p");
  useful.textContent = "Important update";
  d.querySelector("#slot")!.append(useful);
  cleaner.apply([rule]);
  assert.equal((d.querySelector("#slot") as HTMLElement).style.display, "");
  cleaner.restore();
  const banner = d.querySelector(".ad-banner") as HTMLElement;
  assert.equal(banner.style.display, "block");
  assert.equal(banner.style.getPropertyPriority("display"), "important");
  assert.equal((d.querySelector("#slot") as HTMLElement).style.minHeight, "300px");
});

test("cookie overlays release scroll locks reversibly, but not behind other modals", () => {
  const d = doc(
    '<body style="overflow-y:hidden"><main>News</main><div class="cookie-banner" style="position:fixed">Cookies <button>Accept</button></div></body>',
  );
  const cleaner = createCleaner(d);
  const rules = [{ selector: "div.cookie-banner", category: "cookie" as const, enabled: true }];
  cleaner.apply(rules);
  assert.equal(d.body.style.overflowY, "auto");
  const login = d.createElement("div");
  login.setAttribute("role", "dialog");
  login.textContent = "Log in";
  d.body.append(login);
  cleaner.apply(rules);
  assert.equal(d.body.style.overflowY, "hidden");
  login.remove();
  cleaner.apply(rules);
  cleaner.restore();
  assert.equal(d.body.style.overflowY, "hidden");
});

test("manual default, disabled mode/key/profile and persisted attempts block automatic calls", () => {
  const settings: Settings = {
    mode: "auto",
    enabled: true,
    apiKey: "synthetic-test-key",
    provider: "vercel",
  };
  assert.equal(shouldAutoAnalyze(settings, null, false), true);
  assert.equal(shouldAutoAnalyze({ ...settings, mode: "manual" }, null, false), false);
  assert.equal(shouldAutoAnalyze({ ...settings, enabled: false }, null, false), false);
  assert.equal(shouldAutoAnalyze({ ...settings, apiKey: "" }, null, false), false);
  assert.equal(shouldAutoAnalyze(settings, null, true), false);
  const old = profileSchema.parse({
    key: "test",
    origin: "https://example.com",
    label: "article",
    enabled: true,
    version: 1,
    analyzedAt: 1,
    candidateCount: 0,
    rules: [],
  });
  assert.equal(old.analysisVersion, 1);
  assert.equal(shouldAutoAnalyze(settings, old, false), true);
  assert.equal(shouldAutoAnalyze(settings, { ...old, enabled: false }, false), false);
  assert.equal(
    shouldAutoAnalyze(settings, { ...old, analysisVersion: ANALYSIS_VERSION }, false),
    false,
  );
  assert.equal(
    shouldAutoAnalyze(
      settings,
      { ...old, analysisVersion: ANALYSIS_VERSION, candidateCount: 30, rules: [] },
      false,
    ),
    false,
  );
});

const legalese = "We and our partners use cookies to store and access personal data. ".repeat(50);

test("consent platform walls are candidates even with long legal text", () => {
  for (const root of [
    '<div id="iubenda-cs-banner" class="iubenda-cs-visible">',
    '<div class="qc-cmp2-container">',
    '<div class="gdpr-lmd-standard gdpr-lmd-wall">',
    '<div class="privacy-cp-wall">',
    '<aside id="usercentrics-cmp-ui">',
  ]) {
    const tag = root.slice(1, root.indexOf(" "));
    const d = doc(`<main><h1>News</h1></main>${root}${legalese}<button>Accept</button></${tag}>`);
    const candidate = collectCandidates(d).find((c) => c.signals.startsWith("Cookie consent"));
    assert.ok(candidate, root);
  }
});

test("headings, links and scripts named after cookies are never consent UI", () => {
  const d = doc(
    '<main><h2 id="h-why-choose-cookiebot-cmp">Why choose Cookiebot CMP</h2><p>Text</p></main>' +
      '<footer class="site-footer"><a id="kw-cookie-link" href="/c">Gestione Cookie</a></footer>' +
      '<script id="Cookiebot"></script>' +
      '<form><input type="email"><div class="ff-el-gdpr_agreement"><input type="checkbox"> I consent</div></form>',
  );
  assert.equal(cookieEvidence(d.querySelector(".ff-el-gdpr_agreement")!), null);
  for (const selector of ["h2", "a", "script"])
    assert.equal(cookieEvidence(d.querySelector(selector)!), null);
  assert.ok(collectCandidates(d).every((c) => !/^(?:h2|a|script)[#.]/.test(c.selector)));
});

test("a fixed overlay that reads as a consent prompt is a weak candidate, late in the page", () => {
  const modal =
    '<div class="legal-modal" style="position: fixed">Legal Terms and Privacy. By clicking Agree, you agree to our use of cookies.<button>Agree</button></div>';
  const d = doc(`<main><h1>News</h1></main>${"<div></div>".repeat(6100)}${modal}`);
  const el = d.querySelector(".legal-modal")!;
  assert.equal(cookieEvidence(el), "text");
  const candidate = collectCandidates(d).find((c) => c.selector === "div.legal-modal");
  assert.match(candidate!.signals, /^Possible cookie consent overlay\. /);
  (el as HTMLElement).style.position = "static";
  assert.equal(cookieEvidence(el), null);
});

test("only visible, unprotected consent UI asks for a re-check", () => {
  const d = doc(
    '<main><h1>News</h1></main><div id="onetrust-banner-sdk">We use cookies. Accept</div>',
  );
  const banner = d.querySelector("#onetrust-banner-sdk")!;
  const size = { width: 0, height: 0 };
  banner.getBoundingClientRect = () => ({ ...size }) as DOMRect;
  assert.equal(uncoveredConsent(d), false);
  Object.assign(size, { width: 1280, height: 200 });
  assert.equal(uncoveredConsent(d), true);
  banner.append(d.createElement("nav"));
  assert.equal(uncoveredConsent(d), false);
});

test("late consent re-checks need automatic mode, a saved enabled template and no prior attempt", () => {
  const settings: Settings = {
    mode: "auto",
    enabled: true,
    apiKey: "synthetic-test-key",
    provider: "vercel",
  };
  const profile = profileSchema.parse({
    key: "k",
    label: "article",
    origin: "https://example.com",
    enabled: true,
    version: 1,
    analysisVersion: ANALYSIS_VERSION,
    analyzedAt: 1,
    candidateCount: 1,
    rules: [],
  });
  assert.equal(shouldRecheckConsent(settings, profile, false), true);
  assert.equal(shouldRecheckConsent(settings, profile, true), false);
  assert.equal(shouldRecheckConsent(settings, null, false), false);
  assert.equal(shouldRecheckConsent(settings, { ...profile, enabled: false }, false), false);
  assert.equal(shouldRecheckConsent({ ...settings, mode: "manual" }, profile, false), false);
  assert.equal(shouldRecheckConsent({ ...settings, apiKey: "" }, profile, false), false);
});

test("a position-fixed body lock is released with the consent overlay and restored on pause", () => {
  const d = doc(
    '<body style="position: fixed; top: 0px"><main><h1>News</h1></main><div id="sp_message_container_1">Consent</div></body>',
  );
  Object.defineProperty(d.body, "scrollHeight", { value: 5000 });
  const cleaner = createCleaner(d);
  const rules = [
    { selector: 'div[id^="sp_message_container_"]', category: "cookie" as const, enabled: true },
  ];
  cleaner.apply(rules);
  assert.equal(d.body.style.position, "static");
  assert.equal(d.body.style.top, "auto");
  cleaner.apply(rules);
  assert.equal(d.body.style.position, "static");
  cleaner.restore();
  assert.equal(d.body.style.position, "fixed");
  assert.equal(d.body.style.top, "0px");

  const app = doc(
    '<body style="position: fixed"><div id="sp_message_container_1">Consent</div></body>',
  );
  Object.defineProperty(app.body, "scrollHeight", { value: 100 });
  createCleaner(app).apply(rules);
  assert.equal(app.body.style.position, "fixed");
});
