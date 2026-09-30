#!/usr/bin/env node
//
// Marionette-controlled Firefox in CHROME context (not Google Chrome, Firefox chrome context),
// it loads the compiled theme via an temporary profile, in tmp/, with chrome/ symlinked and a generated user.js.
//
// Usage:
//
//   mise run verify-theme                          # all channels, all scenarios
//   mise run verify-theme -- --channels nightly    # one channel
//   mise run verify-theme -- --no-headless         # visible window (debugging)

import { Builder } from "selenium-webdriver";
import * as firefox from "selenium-webdriver/firefox.js";
import { existsSync, rmSync } from "node:fs";
import { findBinary, NOVA_DEFAULT } from "./lib/firefox-bin.mjs";
import { makeThemedProfile } from "./lib/profile.mjs";

const BINARIES = {
    nightly: findBinary("nightly"),
    beta: findBinary("beta"),
    stable: findBinary("stable"),
};

// Scenarios are (theme prefs) applied to a profile. `themed` decides whether the compiled chrome/ is loaded.
// `clean` (themed:false) reads Firefox's own defaults.
const SCENARIOS = [
    {
        id: "themed",
        themed: true,
        // Light scheme pinned (0 = light) so the light-only contracts below are
        // deterministic regardless of the host's appearance setting.
        prefs: {
            "userChrome.theme-material": true,
            "ui.systemUsesDarkTheme": 0,
            // 0 = motion allowed, whatever the host's accessibility setting
            "ui.prefersReducedMotion": 0,
        },
    },
    // The same contracts with Nova off: every channel defaults to Nova since 157,
    // but users can still turn it off, and the Proton branches must keep working.
    {
        id: "themed-proton",
        themed: true,
        nova: false,
        prefs: {
            "userChrome.theme-material": true,
            "ui.systemUsesDarkTheme": 0,
            "ui.prefersReducedMotion": 0,
        },
    },
    // Reduced motion: the theme's loading ring still replaces Firefox's
    // throbber (not Firefox's static hourglass), it just doesn't rotate.
    {
        id: "reduced-motion",
        themed: true,
        prefs: {
            "userChrome.theme-material": true,
            "ui.systemUsesDarkTheme": 0,
            "ui.prefersReducedMotion": 1,
        },
    },
    // A lightweight theme active, as with most users' installed themes: Firefox
    // 157 then outlines the selected tab with
    // `:root[lwtheme] { --tab-border-color-selected: currentColor }` unless the
    // theme sets `tab_line`. Alpenglow is the built-in theme that still counts
    // as one; Light and Dark are "in-app" themes and never set [lwtheme].
    {
        id: "themed-lwt",
        themed: true,
        lwt: "firefox-alpenglow@mozilla.org",
        prefs: {
            "userChrome.theme-material": true,
            "ui.systemUsesDarkTheme": 0,
            "ui.prefersReducedMotion": 0,
        },
    },
    // White open address bar: the open colour differs from the resting one, so a
    // direct paint on .urlbar-background (which would win over Firefox's
    // focused/open variable) shows up here.
    {
        id: "white-urlbar",
        themed: true,
        prefs: {
            "userChrome.theme-material": true,
            "userChrome.ui-white-urlbar-results": true,
            "ui.systemUsesDarkTheme": 0,
        },
    },
    {
        id: "white-toolbox",
        themed: true,
        prefs: {
            "userChrome.theme-material": true,
            "userChrome.ui-white-toolbox": true,
        },
    },
    { id: "clean", themed: false, prefs: {} },
];

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const t = argv[i];
        if (!t.startsWith("--")) continue;
        const key = t.slice(2);
        if (key.startsWith("no-")) args[key.slice(3)] = false;
        else if (i + 1 < argv.length && !argv[i + 1].startsWith("--"))
            args[key] = argv[++i];
        else args[key] = true;
    }
    return args;
}

const list = (v) =>
    String(v)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

// Parse a computed colour (element backgrounds resolve to `color(srgb r g b)`, `rgb(...)` or `rgba(...)`) to {r,g,b,a} with r/g/b in 0-255, a in 0-1.
//
// Returns null for values that stay symbolic (e.g. a custom property still holding `color-mix(...)`), which the checks treat as "not a concrete colour".
function parseColor(s) {
    if (!s || typeof s !== "string") return null;
    let m = s.match(
        /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/i,
    );
    if (m)
        return {
            r: +m[1] * 255,
            g: +m[2] * 255,
            b: +m[3] * 255,
            a: m[4] === undefined ? 1 : +m[4],
        };
    m = s.match(
        /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\)$/i,
    );
    if (m)
        return {
            r: +m[1],
            g: +m[2],
            b: +m[3],
            a: m[4] === undefined ? 1 : +m[4],
        };
    return null;
}

const opaque = (c) => !!c && c.a === 1;
// Same colour within a small per-channel tolerance (colour-mix rounding).
const sameColor = (a, b) =>
    !!a &&
    !!b &&
    ["r", "g", "b"].every((k) => Math.abs(a[k] - b[k]) <= 2) &&
    Math.abs(a.a - b.a) <= 0.02;
const nearWhite = (c) => !!c && c.r >= 235 && c.g >= 235 && c.b >= 235;
const opaqueWhite = (c) => opaque(c) && nearWhite(c);

// Runs in the chrome window (selenium serialises the source), so Services and document are the chrome globals.
// Returns only serialisable data.
function probeScript() {
    const root = getComputedStyle(document.documentElement);
    const v = (n) => root.getPropertyValue(n).trim();
    const bg = (sel) => {
        const e = document.querySelector(sel);
        return e ? getComputedStyle(e).backgroundColor : null;
    };
    const bgOn = (host, sel) => {
        const h = document.querySelector(host);
        if (!h) return null;
        const scoped = getComputedStyle(h).getPropertyValue(sel).trim();
        return scoped || null;
    };
    const has = (sel) => !!document.querySelector(sel);
    // Resolve a colour expression against the theme's variables by painting it
    // on a throwaway element under the root.
    const resolveColor = (expr) => {
        const e = document.createElement("div");
        e.style.backgroundColor = expr;
        document.documentElement.append(e);
        const out = getComputedStyle(e).backgroundColor;
        e.remove();
        return out;
    };
    return {
        version: Services.appinfo.version,
        nova: Services.prefs.getBoolPref("browser.nova.enabled", false),
        // Firefox CSS variables the theme overrides / relies on (drift guard).
        vars: {
            toolbarBackground: v("--toolbar-background-color"),
            toolbarText: v("--toolbar-text-color"),
            tabSelected: v("--tab-background-color-selected"),
            panelBackground: v("--panel-background-color"),
            panelText: v("--panel-text-color"),
            toolbarFieldText: bgOn("#urlbar", "--toolbar-field-text-color"),
            // Legacy names Firefox renamed away -- should be empty on a clean profile.
            legacyToolbarBgcolor: v("--toolbar-bgcolor"),
            legacyTabSelectedBgcolor: v("--tab-selected-bgcolor"),
            legacyArrowpanelBackground: v("--arrowpanel-background"),
        },
        bg: {
            navbar: bg("#nav-bar"),
            toolbox: bg("#navigator-toolbox"),
            tabsToolbar: bg("#TabsToolbar"),
            personalToolbar: bg("#PersonalToolbar"),
        },
        // Whether a lightweight theme is active, and the selected tab's outline
        // colour (Firefox 157 draws it from --tab-border-color-selected).
        lwtheme: document.documentElement.hasAttribute("lwtheme"),
        selectedTabOutline: (() => {
            const e = gBrowser.selectedTab?.querySelector(".tab-background");
            return e ? getComputedStyle(e).outlineColor : null;
        })(),
        // Nav bar height.
        navbarHeight: (() => {
            const e = document.getElementById("nav-bar");
            return e ? e.getBoundingClientRect().height : null;
        })(),
        // Background of the search-mode switcher's inner button (moz-button).
        switcherBackground: (() => {
            const sw = document.querySelector(".searchmode-switcher");
            const part = sw?.shadowRoot?.querySelector('[part="button"]');
            return part ? getComputedStyle(part).backgroundColor : null;
        })(),
        scheme: matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light",
        // Address bar (Firefox 157+). The bar is briefly marked open, and the
        // identity box as a chrome-UI page (about:config's brand chip), so the
        // rendered open surface and chip can be read, then both are restored.
        urlbar: (() => {
            const urlbar = document.getElementById("urlbar");
            const idBox = document.getElementById("identity-box");
            const top = document.querySelector(".urlbar-background");
            const view = document.querySelector(".urlbarView-background");
            const chip = document.getElementById("identity-icon-box");
            if (!urlbar || !idBox || !top || !view || !chip) return null;
            const saved = {
                open: urlbar.getAttribute("open"),
                popover: urlbar.getAttribute("popover-open"),
                cls: idBox.className,
                pps: idBox.getAttribute("pageproxystate"),
            };
            urlbar.setAttribute("open", "true");
            urlbar.setAttribute("popover-open", "true");
            idBox.className = "chromeUI";
            idBox.setAttribute("pageproxystate", "valid");
            const topCs = getComputedStyle(top);
            const viewCs = getComputedStyle(view);
            const out = {
                topBackground: topCs.backgroundColor,
                topShadow: topCs.boxShadow,
                viewBackground: viewCs.backgroundColor,
                viewShadow: viewCs.boxShadow,
                openColor: resolveColor(
                    "var(--md-urlbar-background-color-open)",
                ),
                whiteColor: resolveColor("var(--md-background-color-100)"),
                chipBackground: getComputedStyle(chip).backgroundColor,
            };
            const restore = (el, name, val) =>
                val === null
                    ? el.removeAttribute(name)
                    : el.setAttribute(name, val);
            restore(urlbar, "open", saved.open);
            restore(urlbar, "popover-open", saved.popover);
            idBox.className = saved.cls;
            restore(idBox, "pageproxystate", saved.pps);
            return out;
        })(),
        // Loading ring: mark a tab busy for the read, then restore it.
        throbber: (() => {
            const tab = gBrowser.tabs[0];
            const t = tab && tab.querySelector(".tab-throbber");
            if (!t) return null;
            const wasBusy = tab.hasAttribute("busy");
            tab.setAttribute("busy", "true");
            const cs = getComputedStyle(t);
            const out = {
                reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
                backgroundImage: cs.backgroundImage,
                animationName: cs.animationName,
            };
            if (!wasBusy) tab.removeAttribute("busy");
            return out;
        })(),
        // The light-mode accent tint a dormant _titlebar.scss rule applied to the
        // tab strip once the moz-pref-media `or` branch started working. It
        // must not come back.
        accentTint: resolveColor(
            "color-mix(in srgb, var(--md-accent-color) 40%, var(--md-background-color-50))",
        ),
        exists: {
            urlbar: has("#urlbar"),
            navbar: has("#nav-bar"),
            toolbox: has("#navigator-toolbox"),
            tabs: has("#tabbrowser-tabs"),
            urlbarBackground: has(".urlbar-background"),
        },
    };
}

async function probe({ binary, nova, profileDir, headless, lwt }) {
    const options = new firefox.Options();
    options.addArguments("-no-remote", "-new-instance");
    if (headless) options.addArguments("-headless");
    options.setBinary(binary);
    options.setProfile(profileDir);
    options.setPreference("marionette.allow-system-access", true);
    options.setPreference("remote.allow-system-access", true);
    options.setPreference("devtools.chrome.enabled", true);
    // Skip onboarding / the 158+ pre-onboarding Terms-of-Use splash so it can't
    // block the headless probe.
    options.setPreference("browser.aboutwelcome.enabled", false);
    options.setPreference("browser.preonboarding.enabled", false);
    options.setPreference("termsofuse.bypassNotification", true);
    options.setPreference("browser.nova.enabled", nova);
    options.setPreference(
        "browser.newtabpage.activity-stream.nova.enabled",
        nova,
    );
    const service = new firefox.ServiceBuilder().addArguments(
        "--allow-system-access",
    );
    const driver = await new Builder()
        .forBrowser("firefox")
        .setFirefoxOptions(options)
        .setFirefoxService(service)
        .build();
    try {
        await driver.setContext("chrome");
        if (lwt) {
            // Enable a built-in lightweight theme (same approach as the
            // screenshot harness), then wait for the window to pick it up.
            const res = await driver.executeAsyncScript((id, done) => {
                const { AddonManager } = ChromeUtils.importESModule(
                    "resource://gre/modules/AddonManager.sys.mjs",
                );
                AddonManager.getAddonByID(id)
                    .then((addon) => (addon ? addon.enable() : "missing"))
                    .then(
                        (r) => {
                            const t0 = Date.now();
                            const wait = () =>
                                document.documentElement.hasAttribute(
                                    "lwtheme",
                                ) || Date.now() - t0 > 3000
                                    ? done(r === "missing" ? r : "ok")
                                    : setTimeout(wait, 100);
                            wait();
                        },
                        (e) => done(String(e)),
                    );
            }, lwt);
            if (res !== "ok") console.error(`  lwt ${lwt}: ${res}`);
        }
        await new Promise((r) => setTimeout(r, 600)); // let chrome settle
        return await driver.executeScript(probeScript);
    } finally {
        await driver.quit().catch(() => {});
    }
}

// What I'm calling "contracts", for lack of a better term.
// Each returns { pass, got } given (scenario, probe).
// `channels` (optional) restricts a check to specific channels.
function contractsFor(scenarioId, p) {
    const c = [];
    const add = (name, pass, got) => c.push({ name, pass: !!pass, got });

    if (scenarioId === "themed" || scenarioId === "themed-proton") {
        // The scenario really ran with the Nova state it claims.
        const wantNova = scenarioId === "themed";
        add(wantNova ? "nova-on" : "nova-off", p.nova === wantNova, p.nova);
        // Markup the theme targets still exists.
        for (const k of Object.keys(p.exists))
            add(`exists:${k}`, p.exists[k], p.exists[k]);
        // The URL-bar row must be an opaque light surface -- NOT Firefox's
        // translucent lwtheme default (rgba(255,255,255,0.4)) that reads as grey.
        const nav = parseColor(p.bg.navbar);
        add("navbar-opaque-light", opaqueWhite(nav), p.bg.navbar);
        const pt = parseColor(p.bg.personalToolbar);
        add("bookmarks-opaque-light", opaqueWhite(pt), p.bg.personalToolbar);
        // Toolbox is tinted (default, ui-white-toolbox off): must NOT be white,
        // so the pref A/B below is meaningful.
        const tb = parseColor(p.bg.toolbox);
        add("toolbox-not-white-by-default", !opaqueWhite(tb), p.bg.toolbox);
        // The theme's 38px nav bar (34px pill + 2px above and below), which
        // Firefox 157 would otherwise make 42px.
        add(
            "navbar-height-38",
            p.navbarHeight !== null && Math.abs(p.navbarHeight - 38) <= 1,
            p.navbarHeight,
        );
        // The search-mode switcher is transparent, as the theme intends.
        const sb = parseColor(p.switcherBackground);
        add(
            "searchmode-switcher-transparent",
            p.switcherBackground === "transparent" || (!!sb && sb.a === 0),
            p.switcherBackground,
        );
        // The tab strip keeps the theme's own colour, not the 40% accent tint.
        add("scheme-light", p.scheme === "light", p.scheme);
        // The open bar is one surface: both halves use the theme colour (via
        // --urlbar-background-color-focus) and the same shadow, and the blur
        // fits the joint-background seam (< 24px overlap).
        const u = p.urlbar || {};
        add(
            "urlbar-halves-themed",
            sameColor(parseColor(u.viewBackground), parseColor(u.openColor)) &&
                sameColor(parseColor(u.topBackground), parseColor(u.openColor)),
            `top ${u.topBackground}, results ${u.viewBackground} (want ${u.openColor})`,
        );
        add(
            "urlbar-halves-same-shadow",
            !!u.viewShadow && u.topShadow === u.viewShadow,
            `top ${u.topShadow} | results ${u.viewShadow}`,
        );
        const blurs = [
            ...String(u.viewShadow).matchAll(
                /(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px/g,
            ),
        ].map((m) => +m[3]);
        add(
            "urlbar-shadow-fits-seam",
            blurs.length > 0 && blurs.every((b) => b < 24),
            u.viewShadow,
        );
        // The about: brand chip ("Nightly"/"Firefox") has a visible fill.
        const chip = parseColor(u.chipBackground);
        add("urlbar-chip-filled", !!chip && chip.a > 0, u.chipBackground);
        const tint = parseColor(p.accentTint);
        add("accent-tint-resolves", !!tint, p.accentTint);
        for (const [k, val] of [
            ["toolbox", p.bg.toolbox],
            ["tabsToolbar", p.bg.tabsToolbar],
        ])
            add(
                `tabstrip-not-accent-tinted:${k}`,
                tint && !sameColor(parseColor(val), tint),
                `${val} (tint ${p.accentTint})`,
            );
    }

    if (scenarioId === "themed" || scenarioId === "reduced-motion") {
        const t = p.throbber || {};
        const wantReduced = scenarioId === "reduced-motion";
        add(
            wantReduced ? "motion-reduced" : "motion-allowed",
            t.reduced === wantReduced,
            t.reduced,
        );
        add(
            "throbber-theme-ring",
            /spinner-busy\.svg/.test(String(t.backgroundImage)),
            t.backgroundImage,
        );
        add(
            wantReduced ? "throbber-still" : "throbber-rotates",
            wantReduced
                ? t.animationName === "none"
                : t.animationName === "rotate-360",
            t.animationName,
        );
    }

    if (scenarioId === "themed-lwt") {
        add("lwtheme-active", p.lwtheme === true, p.lwtheme);
        const lo = parseColor(p.selectedTabOutline);
        add(
            "lwt:selected-tab-no-outline",
            p.selectedTabOutline === "transparent" || (!!lo && lo.a === 0),
            p.selectedTabOutline,
        );
    }

    if (scenarioId === "white-urlbar") {
        const u = p.urlbar || {};
        const want = parseColor(u.whiteColor);
        add(
            "white-urlbar:top-half",
            sameColor(parseColor(u.topBackground), want),
            `${u.topBackground} (want ${u.whiteColor})`,
        );
        add(
            "white-urlbar:results-half",
            sameColor(parseColor(u.viewBackground), want),
            `${u.viewBackground} (want ${u.whiteColor})`,
        );
    }

    if (scenarioId === "white-toolbox") {
        // The opt-in must whiten the toolbox band (active window).
        for (const [k, sel] of [
            ["toolbox", p.bg.toolbox],
            ["tabsToolbar", p.bg.tabsToolbar],
        ]) {
            const col = parseColor(sel);
            add(`white-toolbox:${k}`, opaqueWhite(col), sel);
        }
    }

    if (scenarioId === "clean") {
        // Drift guard: the Firefox variables the theme overrides must still exist
        // (non-empty on a clean profile), and the renamed-away legacy names must be
        // gone -- a legacy name reappearing means the override targets a dead token.
        for (const [k, val] of Object.entries(p.vars)) {
            if (k.startsWith("legacy"))
                add(`token-removed:${k}`, val === "", val || "(unset)");
            else add(`token-resolves:${k}`, !!val, val || "(unset)");
        }
    }
    return c;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const channels = args.channels
        ? list(args.channels)
        : ["nightly", "beta", "stable"];
    const scenarios = args.scenarios
        ? SCENARIOS.filter((s) => list(args.scenarios).includes(s.id))
        : SCENARIOS;
    const headless = args.headless !== false;

    const rows = [];
    let failed = 0;

    for (const channel of channels) {
        const binary = BINARIES[channel];
        if (!binary || !existsSync(binary)) {
            rows.push({
                channel,
                scenario: "-",
                name: "binary-present",
                pass: false,
                got: binary
                    ? `missing ${binary}`
                    : `no binary -- run: mise run firefox-download --channel ${channel} (or set $FF_${channel.toUpperCase()})`,
            });
            failed++;
            continue;
        }
        for (const scenario of scenarios) {
            const nova = scenario.nova ?? NOVA_DEFAULT[channel];
            let p;
            const profileDir = makeThemedProfile({
                themed: scenario.themed,
                prefs: scenario.prefs,
                label: "verify",
            });
            try {
                console.error(
                    `\n[${channel}/${scenario.id}] launching (nova=${nova})...`,
                );
                p = await probe({
                    binary,
                    nova,
                    profileDir,
                    headless,
                    lwt: scenario.lwt,
                });
            } catch (err) {
                rows.push({
                    channel,
                    scenario: scenario.id,
                    name: "launch",
                    pass: false,
                    got: err.message,
                });
                failed++;
                continue;
            } finally {
                rmSync(profileDir, { recursive: true, force: true });
            }
            for (const ct of contractsFor(scenario.id, p)) {
                rows.push({ channel, scenario: scenario.id, ...ct });
                if (!ct.pass) failed++;
            }
        }
    }

    // Report (is there a better way to do this that uses an actual JS test suite or something? dunno.)
    console.log("");
    for (const r of rows) {
        const mark = r.pass ? "PASS" : "FAIL";
        console.log(
            `${mark}  ${r.channel.padEnd(7)} ${String(r.scenario).padEnd(13)} ${r.name.padEnd(30)} ${r.pass ? "" : "got=" + r.got}`,
        );
    }
    const total = rows.length;
    console.log(`\n${total - failed}/${total} checks passed.`);
    if (failed) {
        console.error(`FAILED: ${failed} check(s).`);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
