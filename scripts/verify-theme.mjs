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
        prefs: { "userChrome.theme-material": true },
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
        exists: {
            urlbar: has("#urlbar"),
            navbar: has("#nav-bar"),
            toolbox: has("#navigator-toolbox"),
            tabs: has("#tabbrowser-tabs"),
            urlbarBackground: has(".urlbar-background"),
        },
    };
}

async function probe({ binary, nova, profileDir, headless }) {
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

    if (scenarioId === "themed") {
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
                    : `no binary -- run: mise run download-firefox --channel ${channel} (or set $FF_${channel.toUpperCase()})`,
            });
            failed++;
            continue;
        }
        const nova = NOVA_DEFAULT[channel];
        for (const scenario of scenarios) {
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
                p = await probe({ binary, nova, profileDir, headless });
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
