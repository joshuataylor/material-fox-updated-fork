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

// Local page for the feature probe: a file:// URL, so no network is needed, and
// it still gives the address bar a valid page with the Trust Panel chip shown.
const TESTBED_URL = new URL("./input-test.html", import.meta.url).href;

// Scenarios that also run the (slower) feature probe.
const FEATURE_SCENARIOS = new Set([
    "themed",
    "themed-proton",
    "chrome-refresh",
]);

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
    // Chrome-refresh tab strip and toolbar (userChrome.ui-chrome-refresh).
    {
        id: "chrome-refresh",
        themed: true,
        prefs: {
            "userChrome.theme-material": true,
            "userChrome.ui-chrome-refresh": true,
            "ui.systemUsesDarkTheme": 0,
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
// WCAG contrast ratio of two opaque colours, or null if either is missing.
const contrast = (a, b) => {
    if (!a || !b) return null;
    const lum = ({ r, g, b }) =>
        [r, g, b]
            .map((v) => v / 255)
            .map((v) =>
                v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4),
            )
            .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
};

// Runs in the chrome window (selenium serialises the source), so Services and document are the chrome globals.
// Returns only serialisable data.
// Whether the profile's userChrome.css is applied to the browser window. Now and
// then a launch comes up with no theme at all, and without this every contract in
// the scenario fails on Firefox's defaults. The chrome dir listing is for the log.
function themeSheetScript() {
    const dir = Services.dirsvc.get("UChrm", Ci.nsIFile);
    const files = [];
    try {
        const entries = dir.directoryEntries;
        while (entries.hasMoreElements()) files.push(entries.nextFile.leafName);
    } catch (e) {
        files.push(`(unreadable: ${e})`);
    }
    return {
        loaded: InspectorUtils.getAllStyleSheets(document, false).some((s) =>
            /\/chrome\/userChrome\.css$/i.test(s.href || ""),
        ),
        chromeDir: dir.path,
        files: files.join(", "),
        stylesheetsPref: Services.prefs.getBoolPref(
            "toolkit.legacyUserProfileCustomizations.stylesheets",
            false,
        ),
    };
}

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
        os: Services.appinfo.OS,
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
        // Arrow panels keep a one-length --panel-padding (issue #17, #2): the
        // theme's two-value menu padding zeroed the bookmark editor and
        // permission prompts on Windows and Linux. Menus keep the pair.
        panelPadding: (() => {
            StarUI.panel;
            const eb = document.getElementById("editBookmarkPanelContent");
            const menu = document.getElementById("contentAreaContextMenu");
            return {
                editBookmark: eb
                    ? parseFloat(getComputedStyle(eb).paddingInlineStart)
                    : null,
                notification: getComputedStyle(
                    document.getElementById("notification-popup"),
                )
                    .getPropertyValue("--panel-padding")
                    .trim(),
                menu: getComputedStyle(menu)
                    .getPropertyValue("--panel-padding")
                    .trim(),
                menuThemed: matchMedia(
                    "(-moz-platform: windows), (-moz-platform: linux)",
                ).matches,
            };
        })(),
        exists: {
            urlbar: has("#urlbar"),
            navbar: has("#nav-bar"),
            toolbox: has("#navigator-toolbox"),
            tabs: has("#tabbrowser-tabs"),
            urlbarBackground: has(".urlbar-background"),
        },
    };
}

// Drives real UI and measures it, for fixes that need a loaded page or an
// interaction: the results view opened by a click, the find bar, a split view,
// a tab group and the chrome-refresh icons. Runs after probeScript, in the
// chrome window, via executeAsyncScript (`done` is the callback).
function featureProbeScript(url, done) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Wait for a condition rather than a fixed delay. Resolves with the first
    // truthy value, or with the last value once `timeout` ms have passed, so a
    // contract still reports what it saw.
    const waitFor = async (cond, timeout = 3000) => {
        const end = performance.now() + timeout;
        let v = cond();
        while (!v && performance.now() < end) {
            await sleep(20);
            v = cond();
        }
        return v;
    };
    // Wait until a measurement stops changing (an animation or a relayout has
    // finished): the same value on two reads 50ms apart.
    const settled = async (read, timeout = 3000) => {
        const end = performance.now() + timeout;
        let prev = JSON.stringify(read());
        while (performance.now() < end) {
            await sleep(50);
            const cur = JSON.stringify(read());
            if (cur === prev) return;
            prev = cur;
        }
    };
    // Turn a boolean pref on or off and wait for its -moz-pref() media query
    // to follow, at which point the theme's rules for it have applied (in
    // `win`, for a page's own document).
    const setPref = (name, value = true, win = window) => {
        const mq = win.matchMedia(`-moz-pref("${name}")`);
        if (value) Services.prefs.setBoolPref(name, true);
        else Services.prefs.clearUserPref(name);
        return waitFor(() => mq.matches === value, 2000);
    };
    const clearPref = (name, win) => setPref(name, false, win);
    const event = (target, type, timeout = 3000) =>
        Promise.race([
            new Promise((r) =>
                target.addEventListener(type, r, { once: true }),
            ),
            sleep(timeout),
        ]);
    const system = Services.scriptSecurityManager.getSystemPrincipal();
    const addTab = () =>
        gBrowser.addTab("about:blank", {
            triggeringPrincipal: system,
            skipAnimation: true,
        });
    const height = (sel) =>
        document.querySelector(sel)?.getBoundingClientRect().height ?? null;
    const width = (sel) =>
        document.querySelector(sel)?.getBoundingClientRect().width ?? null;
    (async () => {
        const out = {};
        window.resizeTo(1280, 800);
        openTrustedLinkIn(url, "current");
        await waitFor(
            () =>
                gBrowser.selectedBrowser.currentURI.spec === url &&
                !gBrowser.selectedTab.hasAttribute("busy"),
            5000,
        );

        // A mouse-down focus opens the results (157+); the URL text must not
        // move, so the leading Trust Panel chip stays shown (issue #15).
        const urlbar = document.getElementById("urlbar");
        const input = gURLBar.inputField;
        const trust = document.getElementById("trust-icon-container");
        const display = (e) => (e ? getComputedStyle(e).display : null);
        gBrowser.selectedBrowser.focus();
        await waitFor(() => !urlbar.hasAttribute("focused"));
        const x0 = input.getBoundingClientRect().x;
        const trustClosed = display(trust);
        gURLBar.focus();
        gURLBar.startQuery({
            event: new MouseEvent("mousedown"),
            searchString: "",
        });
        // The empty search only opens the view once Firefox has suggestions
        // to show, which on a CI runner's first launch can take a while, so
        // wait for the query (as Firefox's own tests do) and then the view.
        await Promise.race([gURLBar.lastQueryContextPromise, sleep(10000)]);
        await waitFor(() => urlbar.hasAttribute("open"), 10000);
        out.urlbarClick = {
            open: urlbar.hasAttribute("open"),
            shift: input.getBoundingClientRect().x - x0,
            trustClosed,
            trustOpen: display(trust),
            // Why it stayed shut, if it did.
            focused: gURLBar.focused,
            viewOpen: gURLBar.view.isOpen,
            rows: gURLBar.view.visibleRowCount,
        };
        // How far the open surface reaches past the bar, by default and with
        // userChrome.ui-no-urlbar-overhang (fork #19).
        const overhang = () => {
            const u = urlbar.getBoundingClientRect();
            const s = urlbar
                .querySelector(".urlbar-background")
                .getBoundingClientRect();
            // The result rows (and the selection bar) stay inside it.
            const row = urlbar
                .querySelector(".urlbarView-row")
                ?.getBoundingClientRect();
            return {
                left: u.left - s.left,
                top: u.top - s.top,
                right: s.right - u.right,
                rowInset: row ? row.left - s.left : null,
            };
        };
        // Open the results directly if the click did not, so a slow click
        // only fails the click check above.
        if (!urlbar.hasAttribute("open")) {
            gURLBar.focus();
            gURLBar.search("example");
            await waitFor(() => urlbar.hasAttribute("open"));
        }
        const overhangDefault = overhang();
        await setPref("userChrome.ui-no-urlbar-overhang");
        out.urlbarOverhang = {
            open: urlbar.hasAttribute("open"),
            default: overhangDefault,
            pref: overhang(),
        };
        await clearPref("userChrome.ui-no-urlbar-overhang");
        gURLBar.view.close();
        gBrowser.selectedBrowser.focus();
        await waitFor(() => !urlbar.hasAttribute("open"));

        // The find bar clips both axes (no scrollbar), and the top-right bar
        // stays inside a narrow window (issue #8).
        const fb = await gBrowser.getFindBar();
        fb.open();
        await waitFor(() => !fb.hidden && fb.getBoundingClientRect().height);
        out.findbar = { overflow: getComputedStyle(fb).overflow };
        await setPref("userChrome.ui-findbar-top-right");
        window.resizeTo(700, 600);
        await waitFor(() => window.outerWidth === 700);
        await settled(() => fb.getBoundingClientRect().toJSON());
        const fr = fb.getBoundingClientRect();
        out.findbarTopRight = {
            position: getComputedStyle(fb).position,
            overflow: getComputedStyle(fb).overflow,
            left: fr.left,
            right: fr.right,
            windowWidth: window.innerWidth,
        };
        await clearPref("userChrome.ui-findbar-top-right");
        fb.close(true);
        window.resizeTo(1280, 800);
        await waitFor(() => window.outerWidth === 1280 && fb.hidden);

        // A split view keeps the tab strip height (issue #6).
        const stripBefore = height("#TabsToolbar");
        const [s1, s2] = [addTab(), addTab()];
        gBrowser.addTabSplitView([s1, s2], {});
        gBrowser.selectedTab = s1;
        await waitFor(() => document.querySelector("tab-split-view-wrapper"));
        await settled(() => [
            height("#TabsToolbar"),
            s1.getBoundingClientRect().height,
        ]);
        out.splitView = {
            stripBefore,
            stripAfter: height("#TabsToolbar"),
            wrapper: height("tab-split-view-wrapper"),
            tab: s1.getBoundingClientRect().height,
        };
        gBrowser.removeTabs([s1, s2]);
        await waitFor(() => !s1.isConnected && !s2.isConnected);

        // The group line shows under an unselected grouped tab, the label is a
        // chip, the label line is drawn over the selected tab's corners, and a
        // collapsed group clips its hidden tabs and drops their line (issue #16).
        const [g1, g2] = [addTab(), addTab()];
        const group = gBrowser.addTabGroup([g1, g2], { label: "verify" });
        gBrowser.selectedTab = gBrowser.tabs[0];
        await settled(() => group.getBoundingClientRect().toJSON());
        out.tabGroup = {
            line: getComputedStyle(g2.querySelector(".tab-stack"), "::after")
                .backgroundColor,
            label:
                group.querySelector(".tab-group-label")?.getBoundingClientRect()
                    .height ?? null,
        };
        gBrowser.selectedTab = g1;
        out.tabGroup.labelLineZ = getComputedStyle(
            group.querySelector(".tab-group-label-container"),
            "::after",
        ).zIndex;
        out.tabGroup.selectedBackgroundZ = getComputedStyle(
            g1.querySelector(".tab-background"),
        ).zIndex;
        gBrowser.selectedTab = gBrowser.tabs[0];
        group.collapsed = true;
        await waitFor(() => group.hasAttribute("collapsed"));
        await settled(() => g2.getBoundingClientRect().toJSON());
        out.tabGroup.collapsedOverflow = getComputedStyle(g2).overflow;
        out.tabGroup.collapsedLine = getComputedStyle(
            g2.querySelector(".tab-stack"),
            "::after",
        ).display;
        gBrowser.removeTabs([g1, g2]);
        await waitFor(() => !g1.isConnected && !g2.isConnected);

        // Toolbar and new-tab icon boxes and a pinned tab's icon centring;
        // asserted only in the chrome-refresh scenario (issue #12).
        // The first tab's start margin applies only without pinned tabs, so
        // the gap after the last pinned tab matches the gap between other
        // tabs (fork #21).
        const bgOf = (tab) =>
            tab.querySelector(".tab-background").getBoundingClientRect();
        const spare = addTab();
        await waitFor(() => spare.getBoundingClientRect().width);
        const firstMarginNoPinned = parseFloat(
            getComputedStyle(gBrowser.tabs[0]).marginLeft,
        );
        const pinned = addTab();
        gBrowser.pinTab(pinned);
        await waitFor(() => pinned.pinned);
        await settled(() => [
            pinned
                .querySelector(".tab-background")
                .getBoundingClientRect()
                .toJSON(),
            pinned
                .querySelector(".tab-icon-stack")
                .getBoundingClientRect()
                .toJSON(),
        ]);
        const pb = pinned
            .querySelector(".tab-background")
            .getBoundingClientRect();
        const pi = pinned
            .querySelector(".tab-icon-stack")
            .getBoundingClientRect();
        const stripTabs = gBrowser.tabs.filter((tab) => !tab.pinned);
        out.pinnedGap = {
            firstMarginNoPinned,
            afterPinned: Math.round(
                bgOf(stripTabs[0]).left - bgOf(pinned).right,
            ),
            between: Math.round(
                bgOf(stripTabs[1]).left - bgOf(stripTabs[0]).right,
            ),
        };
        out.icons = {
            back: width("#back-button > .toolbarbutton-icon"),
            extensions: width(
                "#unified-extensions-button > .toolbarbutton-icon",
            ),
            newtab: width("#tabs-newtab-button > .toolbarbutton-icon"),
            pinnedOffset: pi.x + pi.width / 2 - (pb.x + pb.width / 2),
        };

        // Opt-in prefs on the (unselected) pinned tab: no title-changed dot,
        // and the audio button lets clicks through to the tab (issue #16).
        const content = pinned.querySelector(".tab-content");
        const overlay = pinned.querySelector(".tab-icon-overlay");
        content.toggleAttribute("titlechanged", true);
        const dotDefault = getComputedStyle(content).backgroundImage;
        await setPref("userChrome.ui-no-tab-title-changed-dot");
        await setPref("userChrome.ui-no-pinned-tab-mute-click");
        out.pinnedPrefs = {
            dotDefault,
            dot: getComputedStyle(content).backgroundImage,
            overlay: getComputedStyle(overlay).pointerEvents,
        };
        await clearPref("userChrome.ui-no-tab-title-changed-dot");
        await clearPref("userChrome.ui-no-pinned-tab-mute-click");
        // ui-no-tab-audio-background drops the ring round a muted pinned
        // tab's audio button: a border up to 157, an outline from 158
        // (fork #21).
        pinned.toggleAttribute("muted", true);
        overlay.toggleAttribute("muted", true);
        overlay.toggleAttribute("pinned", true);
        const ring = () => {
            const cs = getComputedStyle(overlay);
            const outline =
                cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
            const border =
                parseFloat(cs.borderTopWidth) > 0 &&
                cs.borderTopColor !== "rgba(0, 0, 0, 0)";
            return {
                any: outline || border || cs.boxShadow !== "none",
                outline: `${cs.outlineStyle} ${cs.outlineWidth}`,
                border: `${cs.borderTopWidth} ${cs.borderTopColor}`,
                shadow: cs.boxShadow,
            };
        };
        const ringDefault = ring();
        await setPref("userChrome.ui-no-tab-audio-background");
        out.pinnedPrefs.ringDefault = ringDefault;
        out.pinnedPrefs.ring = ring();
        await clearPref("userChrome.ui-no-tab-audio-background");
        // macOS fades unselected tab labels and background favicons;
        // ui-no-tab-dimming keeps both at full strength.
        const dimming = () => ({
            label: getComputedStyle(spare.querySelector(".tab-label-container"))
                .opacity,
            pinnedIcon: getComputedStyle(
                pinned.querySelector(".tab-icon-image"),
            ).opacity,
        });
        out.tabDimming = {
            platform: AppConstants.platform,
            default: dimming(),
        };
        await setPref("userChrome.ui-no-tab-dimming");
        out.tabDimming.pref = dimming();
        await clearPref("userChrome.ui-no-tab-dimming");
        gBrowser.removeTab(pinned);
        gBrowser.removeTab(spare);

        // The nav bar's start corner is square while the first tab is selected and rounded otherwise.
        const nav = document.getElementById("nav-bar");
        const other = addTab();
        gBrowser.selectedTab = gBrowser.tabs[0];
        const cornerFirst = getComputedStyle(nav).borderStartStartRadius;
        gBrowser.selectedTab = other;
        out.navCorner = {
            first: cornerFirst,
            other: getComputedStyle(nav).borderStartStartRadius,
        };
        gBrowser.selectedTab = gBrowser.tabs[0];
        gBrowser.removeTab(other);

        // Opt-in history badge pref on a stand-in result row: Firefox's
        // badge-history rule keys on the row type only (issue #18).
        const row = document.createElement("div");
        row.className = "urlbarView-row";
        row.setAttribute("type", "history");
        row.innerHTML =
            '<div class="urlbarView-row-inner"><img class="urlbarView-favicon"/><span class="urlbarView-type-icon"></span></div>';
        document.documentElement.append(row);
        const fav = row.querySelector(".urlbarView-favicon");
        const badge = row.querySelector(".urlbarView-type-icon");
        const maskDefault = getComputedStyle(fav).maskImage;
        await setPref("userChrome.ui-no-urlbar-history-badge");
        out.historyBadge = {
            maskDefault,
            mask: getComputedStyle(fav).maskImage,
            badge: getComputedStyle(badge).display,
        };
        await clearPref("userChrome.ui-no-urlbar-history-badge");
        row.remove();

        // Opt-in Chromium tab hover timing on an unselected tab: 300ms out,
        // 100ms in (edelvarden/material-fox-updated#147).
        const hoverTab = addTab();
        gBrowser.selectedTab = gBrowser.tabs[0];
        const hoverBg = hoverTab.querySelector(".tab-background");
        const duration = () => getComputedStyle(hoverBg).transitionDuration;
        const hoverDefault = duration();
        await setPref("userChrome.ui-chromium-tab-hover");
        const hoverRest = duration();
        const hr = hoverTab.getBoundingClientRect();
        window.synthesizeMouseEvent(
            "mousemove",
            hr.left + hr.width / 2,
            hr.top + hr.height / 2,
            {},
        );
        await waitFor(() => hoverTab.matches(":hover"));
        out.tabHover = {
            hovered: hoverTab.matches(":hover"),
            default: hoverDefault,
            rest: hoverRest,
            hover: duration(),
        };
        window.synthesizeMouseEvent("mousemove", 5, window.innerHeight - 5, {});
        await clearPref("userChrome.ui-chromium-tab-hover");
        gBrowser.removeTab(hoverTab);
        await waitFor(() => !hoverTab.isConnected);

        // The tab hover preview is centred under a full-width tab (fork #21).
        // It only opens headful, so read its margin against the tab's maximum
        // width and the panel's width.
        const preview = document.getElementById("tab-preview-panel");
        if (preview) {
            const ps = getComputedStyle(preview);
            out.tabPreview = {
                marginStart: parseFloat(ps.marginInlineStart),
                shadowMargin:
                    parseFloat(
                        ps.getPropertyValue("--panel-box-shadow-margin"),
                    ) || 0,
                width: parseFloat(ps.getPropertyValue("--panel-width")),
                tabMax: parseFloat(
                    getComputedStyle(
                        document.getElementById("tabbrowser-tabs"),
                    ).getPropertyValue("--tab-max-width"),
                ),
            };
        }

        // Opt-in ui-themed-pages: Settings' canvas on the theme palette
        // (edelvarden/material-fox-updated#124). about:preferences runs in
        // the parent process, so its window is readable from here.
        const prefsTab = gBrowser.addTab("about:preferences", {
            triggeringPrincipal: system,
            skipAnimation: true,
        });
        gBrowser.selectedTab = prefsTab;
        // The tab starts on about:blank, which is already complete.
        await waitFor(() => {
            const doc = prefsTab.linkedBrowser.contentDocument;
            return (
                doc?.documentURI.startsWith("about:preferences") &&
                doc.readyState === "complete"
            );
        }, 5000);
        const pageStyle = () =>
            prefsTab.linkedBrowser.contentWindow.getComputedStyle(
                prefsTab.linkedBrowser.contentDocument.documentElement,
            );
        const canvasDefault = pageStyle()
            .getPropertyValue("--background-color-canvas")
            .trim();
        await setPref(
            "userChrome.ui-themed-pages",
            true,
            prefsTab.linkedBrowser.contentWindow,
        );
        out.themedPages = {
            default: canvasDefault,
            pref: pageStyle()
                .getPropertyValue("--background-color-canvas")
                .trim(),
            palette: pageStyle()
                .getPropertyValue("--md-background-color-50")
                .trim(),
        };
        await clearPref("userChrome.ui-themed-pages");
        gBrowser.removeTab(prefsTab);
        gBrowser.selectedTab = gBrowser.tabs[0];
        await waitFor(() => !prefsTab.isConnected);

        // Opt-in tab counter on the "List all tabs" button
        // (edelvarden/material-fox-updated#86).
        const stack = document.querySelector(
            "#alltabs-button > .toolbarbutton-badge-stack",
        );
        const counter = () => ({
            content: getComputedStyle(stack, "::after").content,
            icon: getComputedStyle(stack.querySelector(".toolbarbutton-icon"))
                .opacity,
        });
        // The number as drawn: the text of the ::after generated content on the
        // button, or on #tabbrowser-tabs when the button sits before the tabs.
        const drawnCount = () => {
            const text = (el) =>
                InspectorUtils.getChildrenForNode(el, true, false).find(
                    (k) => k.nodeName === "_moz_generated_content_after",
                )?.textContent ?? null;
            return {
                button: text(stack),
                strip: text(document.getElementById("tabbrowser-tabs")),
            };
        };
        const counterDefault = counter();
        await setPref("userChrome.ui-tab-counter");
        const counterPref = counter();
        const drawnDefault = drawnCount();
        // Where the tab strip starts, and whether Firefox's divider before the
        // tabs shows (fork #21).
        const stripStart = () => ({
            firstTab: Math.round(gBrowser.tabs[0].getBoundingClientRect().left),
            separator: getComputedStyle(
                document.getElementById("tabbrowser-tabs"),
                "::before",
            ).borderInlineStartStyle,
            separatorDisplay: getComputedStyle(
                document.getElementById("tabbrowser-tabs"),
                "::before",
            ).display,
        });
        const startDefault = stripStart();
        // Moved to the start of the tab strip in Customise (fork #21), where the
        // button's own counter has seen no tabs.
        const allTabsPos =
            CustomizableUI.getPlacementOfWidget("alltabs-button").position;
        CustomizableUI.moveWidgetWithinArea("alltabs-button", 0);
        await settled(() => [drawnCount(), stripStart()]);
        const drawnFirst = drawnCount();
        const startFirst = stripStart();
        CustomizableUI.moveWidgetWithinArea("alltabs-button", allTabsPos);
        await settled(() => stripStart());
        out.tabCounter = {
            default: counterDefault,
            pref: counterPref,
            tabs: gBrowser.tabs.length,
            drawnDefault,
            drawnFirst,
        };
        out.tabStripStart = {
            platform: AppConstants.platform,
            default: startDefault,
            first: startFirst,
        };
        await clearPref("userChrome.ui-tab-counter");

        // Opt-in ui-no-inactive-titlebar: with another window in front, the
        // toolbox keeps its active colour instead of the theme's grey
        // (edelvarden/material-fox-updated#140).
        const toolboxBg = () =>
            getComputedStyle(document.getElementById("navigator-toolbox"))
                .backgroundColor;
        // Firefox also fades the tab strip (.browser-titlebar) when inactive
        // (fork #21).
        const stripOpacity = () =>
            getComputedStyle(document.getElementById("TabsToolbar")).opacity;
        // Chrome still fades the new tab button (fork #21).
        const newTabOpacity = () =>
            getComputedStyle(document.getElementById("tabs-newtab-button"))
                .opacity;
        const activeToolbox = toolboxBg();
        const otherWindow = OpenBrowserWindow();
        await waitFor(
            () => document.documentElement.matches(":-moz-window-inactive"),
            5000,
        );
        // Both fade over --inactive-window-transition.
        await settled(() => [toolboxBg(), stripOpacity()]);
        const inactiveDefault = toolboxBg();
        const opacityDefault = stripOpacity();
        await setPref("userChrome.ui-no-inactive-titlebar");
        await settled(() => [toolboxBg(), stripOpacity(), newTabOpacity()]);
        out.inactiveTitlebar = {
            inactive: document.documentElement.matches(":-moz-window-inactive"),
            customTitlebar:
                document.documentElement.hasAttribute("customtitlebar"),
            active: activeToolbox,
            default: inactiveDefault,
            pref: toolboxBg(),
            opacityDefault,
            opacityPref: stripOpacity(),
            newTabOpacityPref: newTabOpacity(),
            platform: AppConstants.platform,
        };
        await clearPref("userChrome.ui-no-inactive-titlebar");
        otherWindow.close();
        window.focus();
        await waitFor(
            () => !document.documentElement.matches(":-moz-window-inactive"),
            5000,
        );

        // Menus, opened by a synthesised right-click and measured row by row
        // (edelvarden/material-fox-updated#150, #145, #135). Windows and Linux
        // only: macOS menus are native and the theme leaves them alone.
        if (AppConstants.platform !== "macosx") {
            const mouse = (type, x, y) =>
                window.synthesizeMouseEvent(type, x, y, {
                    button: 2,
                    buttons: 2,
                    clickCount: 1,
                });
            const openMenu = async (popupId, el, dx, dy) => {
                const popup = document.getElementById(popupId);
                const r = el.getBoundingClientRect();
                const x = r.left + (dx ?? r.width / 2);
                const y = r.top + (dy ?? r.height / 2);
                const shown = event(popup, "popupshown");
                for (const type of ["mousedown", "contextmenu", "mouseup"])
                    mouse(type, x, y);
                await shown;
                await settled(() => popup.getBoundingClientRect().toJSON());
                const pr = popup.getBoundingClientRect();
                // Firefox's row padding, resolved in this popup.
                const pad = document.createElement("div");
                pad.style.paddingInlineStart = "var(--menuitem-padding-inline)";
                popup.append(pad);
                const fxPadding = parseFloat(
                    getComputedStyle(pad).paddingInlineStart,
                );
                pad.remove();
                const rows = [
                    ...popup.querySelectorAll(
                        ":scope > menuitem, :scope > menu, :scope > menugroup > menuitem",
                    ),
                ]
                    .filter((i) => !i.hidden && i.getBoundingClientRect().width)
                    .map((item) => {
                        const icon = item.querySelector(":scope > .menu-icon");
                        const text = item.querySelector(":scope > .menu-text");
                        const ir = icon?.getBoundingClientRect();
                        const tr = text?.getBoundingClientRect();
                        const ics = icon && getComputedStyle(icon);
                        const column =
                            ics && ics.display !== "none"
                                ? ir.width + parseFloat(ics.marginInlineEnd)
                                : 0;
                        // Text start past Firefox's row padding and icon
                        // column: 0 when the text sits where Firefox puts it.
                        const inset = tr?.width
                            ? Math.round(
                                  tr.left -
                                      item.getBoundingClientRect().left -
                                      fxPadding -
                                      column,
                              )
                            : null;
                        return {
                            inset,
                            id: item.id,
                            h: Math.round(item.getBoundingClientRect().height),
                            icon:
                                !!ir?.width &&
                                getComputedStyle(icon).visibility !== "hidden",
                            bgIcon:
                                getComputedStyle(item).backgroundImage !==
                                "none",
                            textX: tr?.width
                                ? Math.round(tr.left - pr.left)
                                : null,
                            // The nav rows draw their label in ::after, right
                            // after the icon's margin box.
                            labelX:
                                !tr?.width && ir?.width
                                    ? Math.round(
                                          ir.right +
                                              parseFloat(ics.marginInlineEnd) -
                                              pr.left,
                                      )
                                    : null,
                        };
                    });
                const hidden = event(popup, "popuphidden");
                popup.hidePopup();
                await hidden;
                return { gutter: popup.hasAttribute("needsgutter"), rows };
            };
            const page = gBrowser.selectedBrowser;
            const pageWidth = page.getBoundingClientRect().width;
            out.menus = {
                page: await openMenu(
                    "contentAreaContextMenu",
                    page,
                    pageWidth - 20,
                ),
                tab: await openMenu("tabContextMenu", gBrowser.selectedTab),
            };
            // A checked item (Menu Bar) makes Firefox add the gutter.
            CustomizableUI.setToolbarVisibility("toolbar-menubar", true);
            await waitFor(
                () =>
                    document
                        .getElementById("toolbar-menubar")
                        .getBoundingClientRect().height,
            );
            out.menus.toolbar = await openMenu(
                "toolbar-context-menu",
                document.getElementById("reload-button"),
            );
            CustomizableUI.setToolbarVisibility("toolbar-menubar", false);
            await setPref("userChrome.ui-context-menu-icons");
            out.menus.tabIcons = await openMenu(
                "tabContextMenu",
                gBrowser.selectedTab,
            );
            out.menus.pageIcons = await openMenu(
                "contentAreaContextMenu",
                page,
                pageWidth - 20,
            );
            await clearPref("userChrome.ui-context-menu-icons");
            // userChrome.ui-menu-icon-column: every row gets the icon column,
            // so the labels line up with the nav rows' (fork #21).
            await setPref("userChrome.ui-menu-icon-column");
            out.menus.pageColumn = await openMenu(
                "contentAreaContextMenu",
                page,
                pageWidth - 20,
            );
            await clearPref("userChrome.ui-menu-icon-column");
        }

        // Vertical tabs: no corner flares, all corners rounded
        // (edelvarden/material-fox-updated#141).
        Services.prefs.setBoolPref("sidebar.revamp", true);
        Services.prefs.setBoolPref("sidebar.verticalTabs", true);
        const tabsOrient = () =>
            document.getElementById("tabbrowser-tabs").getAttribute("orient");
        await waitFor(() => tabsOrient() === "vertical");
        await settled(() =>
            gBrowser.selectedTab.getBoundingClientRect().toJSON(),
        );
        const vbg = gBrowser.selectedTab.querySelector(".tab-background");
        out.verticalTab = {
            orient: document
                .getElementById("tabbrowser-tabs")
                .getAttribute("orient"),
            flare: getComputedStyle(vbg, "::before").display,
            bottomRadius: getComputedStyle(vbg).borderBottomLeftRadius,
        };
        // The rest of the strip (edelvarden/material-fox-updated#134):
        // expanded rows share one text start with no separators, and pinned
        // tabs fill their grid cells; collapsed favicons are centred with no
        // close button.
        const [v1, v2] = [addTab(), addTab()];
        const vpin = addTab();
        gBrowser.pinTab(vpin);
        gBrowser.selectedTab = gBrowser.tabs[1];
        await settled(() => [
            vpin.getBoundingClientRect().toJSON(),
            v2.getBoundingClientRect().toJSON(),
        ]);
        const unpinned = gBrowser.tabs.filter((t) => !t.pinned);
        const centre = (e) => {
            const r = e.getBoundingClientRect();
            return r.left + r.width / 2;
        };
        const strip = document.getElementById("vertical-tabs");
        // Tab titles and the New Tab label.
        out.verticalTab.labelX = [
            ...new Set(
                [
                    ...unpinned.map((t) =>
                        t.querySelector(".tab-label-container"),
                    ),
                    document.querySelector(
                        "#tabs-newtab-button > .toolbarbutton-text",
                    ),
                ].map((e) => Math.round(e.getBoundingClientRect().left)),
            ),
        ];
        // The New Tab label at the tab titles' size.
        out.verticalTab.fontSizes = [
            getComputedStyle(unpinned[0].querySelector(".tab-label")).fontSize,
            getComputedStyle(
                document.querySelector(
                    "#tabs-newtab-button > .toolbarbutton-text",
                ),
            ).fontSize,
        ];
        out.verticalTab.separator = getComputedStyle(
            v2.querySelector(".tab-content"),
            "::before",
        ).display;
        out.verticalTab.pinnedWidth = vpin.getBoundingClientRect().width;
        SidebarController._state.launcherExpanded = false;
        await waitFor(
            () =>
                !document
                    .getElementById("tabbrowser-tabs")
                    .hasAttribute("expanded"),
        );
        await settled(() => strip.getBoundingClientRect().toJSON());
        out.verticalTab.collapsed = {
            expanded: document
                .getElementById("tabbrowser-tabs")
                .hasAttribute("expanded"),
            iconOffsets: unpinned.map((t) =>
                Math.round(
                    centre(t.querySelector(".tab-icon-stack")) - centre(strip),
                ),
            ),
            close: getComputedStyle(
                unpinned[0].querySelector(".tab-close-button"),
            ).display,
        };
        SidebarController._state.launcherExpanded = true;
        gBrowser.removeTabs([v1, v2, vpin]);
        await waitFor(() => !v1.isConnected && !vpin.isConnected);
        Services.prefs.clearUserPref("sidebar.verticalTabs");
        Services.prefs.clearUserPref("sidebar.revamp");
        await waitFor(() => tabsOrient() === "horizontal");
        await settled(() =>
            gBrowser.selectedTab.getBoundingClientRect().toJSON(),
        );

        // Toolbar spacing (fork issue #12), last because it rearranges the
        // nav bar: the all-tabs circle is centred on an unselected tab (the
        // selected tab's background runs into the toolbar, fork #21), the
        // first and last buttons and the URL bar sit as far from their
        // neighbours as the buttons sit from the top of the bar, and grouped
        // buttons (zoom, cut/copy/paste) keep the 4px gap of single ones.
        const circle = (b) =>
            (
                b.querySelector(":scope > .toolbarbutton-badge-stack") ||
                b.querySelector(":scope > .toolbarbutton-icon")
            ).getBoundingClientRect();
        const allTabs = document.querySelector(
            "#alltabs-button > .toolbarbutton-badge-stack",
        );
        const spareTab = addTab();
        await settled(() => spareTab.getBoundingClientRect().toJSON());
        const tabBg = spareTab
            .querySelector(".tab-background")
            .getBoundingClientRect();
        const atr = allTabs?.getBoundingClientRect();
        gBrowser.removeTab(spareTab);
        await waitFor(() => !spareTab.isConnected);
        for (const id of CustomizableUI.getWidgetIdsInArea("nav-bar"))
            if (id.includes("spring")) CustomizableUI.removeWidgetFromArea(id);
        CustomizableUI.addWidgetToArea(
            "zoom-controls",
            "nav-bar",
            CustomizableUI.getWidgetIdsInArea("nav-bar").indexOf(
                "urlbar-container",
            ) + 1,
        );
        CustomizableUI.addWidgetToArea("edit-controls", "nav-bar");
        await waitFor(() => document.getElementById("paste-button"));
        await settled(() =>
            document.getElementById("nav-bar").getBoundingClientRect().toJSON(),
        );
        const navR = document.getElementById("nav-bar").getBoundingClientRect();
        const urlR = document.getElementById("urlbar").getBoundingClientRect();
        const buttons = [
            ...document.querySelectorAll(
                "#nav-bar toolbarbutton.toolbarbutton-1",
            ),
        ]
            .filter((b) => b.getBoundingClientRect().width)
            .map(circle);
        const round = (v) => Math.round(v * 10) / 10;
        const id = (x) => circle(document.getElementById(x));
        // On Windows without Chrome Refresh the button is drawn like a
        // caption button, the full height of the strip, so it centres on the
        // strip rather than on the tab.
        const stripR = document
            .getElementById("TabsToolbar")
            .getBoundingClientRect();
        const captionStyle = atr && atr.height >= stripR.height - 1;
        const target = captionStyle ? stripR : tabBg;
        out.toolbarSpacing = {
            allTabsCaption: captionStyle,
            allTabsOffset: atr
                ? round(
                      atr.top +
                          atr.height / 2 -
                          (target.top + target.height / 2),
                  )
                : null,
            top: round(id("back-button").top - navR.top),
            first: round(buttons[0].left - navR.left),
            last: round(navR.right - buttons.at(-1).right),
            beforeUrlbar: round(urlR.left - id("reload-button").right),
            afterUrlbar: round(id("zoom-out-button").left - urlR.right),
            between: round(id("forward-button").left - id("back-button").right),
            afterZoom: round(
                buttons.find((r) => r.left > id("zoom-in-button").right).left -
                    id("zoom-in-button").right,
            ),
            afterEdit: round(
                buttons.find((r) => r.left > id("paste-button").right).left -
                    id("paste-button").right,
            ),
        };
        await PlacesUIUtils.maybeAddImportButton();
        await waitFor(() => document.getElementById("import-button"), 1000);
        const importButton = document.getElementById("import-button");
        out.toolbarSpacing.importTransition = importButton
            ? getComputedStyle(importButton).transitionProperty
            : null;

        // Text on the accent colour, in dark mode, where the theme's accent is
        // light: the "Saved to bookmarks" hint (its own text and background,
        // which the Windows/Linux menu text colour used to override) and
        // primary buttons (Firefox's text is AccentColorText on Linux).
        const darkMq = matchMedia("(prefers-color-scheme: dark)");
        const wasDark = Services.prefs.prefHasUserValue(
            "ui.systemUsesDarkTheme",
        )
            ? Services.prefs.getIntPref("ui.systemUsesDarkTheme")
            : null;
        Services.prefs.setIntPref("ui.systemUsesDarkTheme", 1);
        await waitFor(() => darkMq.matches);
        ConfirmationHint.show(
            document.getElementById("PanelUI-menu-button"),
            "confirmation-hint-page-bookmarked",
            {},
        );
        const hint = await waitFor(() => {
            const h = document.getElementById("confirmation-hint");
            return h?.state === "open" && h;
        });
        const accentColor = (prop) => {
            const e = document.createElement("div");
            e.style.backgroundColor = `var(${prop})`;
            document.documentElement.append(e);
            const c = getComputedStyle(e).backgroundColor;
            e.remove();
            return c;
        };
        out.accentText = {
            dark: darkMq.matches,
            hintText: hint
                ? getComputedStyle(
                      document.getElementById("confirmation-hint-message"),
                  ).color
                : null,
            hintBackground: hint
                ? getComputedStyle(
                      hint.shadowRoot.querySelector("[part=content]"),
                  ).backgroundColor
                : null,
            buttonText: accentColor("--button-text-color-primary"),
            buttonBackground: accentColor("--button-background-color-primary"),
        };
        hint?.hidePopup();
        if (wasDark === null)
            Services.prefs.clearUserPref("ui.systemUsesDarkTheme");
        else Services.prefs.setIntPref("ui.systemUsesDarkTheme", wasDark);
        await waitFor(
            () => wasDark === null || darkMq.matches === (wasDark === 1),
        );
        done(out);
    })().catch((e) => done({ error: String(e) }));
}

async function probe({
    binary,
    nova,
    profileDir,
    headless,
    lwt,
    features,
    themed,
}) {
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
        if (themed) {
            const sheet = await driver.executeScript(themeSheetScript);
            if (!sheet.loaded) return { themeMissing: sheet };
        }
        const p = await driver.executeScript(probeScript);
        if (features) {
            await driver.manage().setTimeouts({ script: 60000 });
            p.features = await driver.executeAsyncScript(
                featureProbeScript,
                TESTBED_URL,
            );
        }
        return p;
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

    if (scenarioId === "themed" || scenarioId === "themed-proton") {
        const f = p.features || {};
        add("feature-probe", !f.error, f.error);
        // A click into the address bar opens the results without moving the
        // URL text: the Trust Panel chip stays shown (issue #15).
        const uc = f.urlbarClick || {};
        add(
            "urlbar-click-opens-results",
            uc.open === true,
            `open ${uc.open}, focused ${uc.focused}, view ${uc.viewOpen}, rows ${uc.rows}`,
        );
        add(
            "urlbar-click-text-still",
            typeof uc.shift === "number" &&
                Math.abs(uc.shift) < 1 &&
                uc.trustClosed !== "none" &&
                uc.trustOpen !== "none",
            `shift ${uc.shift}px, chip ${uc.trustClosed} -> ${uc.trustOpen}`,
        );
        // userChrome.ui-no-urlbar-overhang keeps the open surface flush with
        // the bar. Nova grows it by 8px by default (fork #19).
        const oh = f.urlbarOverhang || {};
        const flush = (o) =>
            !!o && [o.left, o.top, o.right].every((v) => Math.abs(v) < 0.5);
        add(
            "urlbar-overhang-pref-flush",
            oh.open === true &&
                flush(oh.pref) &&
                oh.pref.rowInset >= 0 &&
                (scenarioId !== "themed" || oh.default?.left > 0),
            `default ${JSON.stringify(oh.default)}, pref ${JSON.stringify(oh.pref)}`,
        );
        // The find bar clips both axes, so it never shows a scrollbar, and the
        // top-right bar fits a 700px window (issue #8).
        add(
            "findbar-overflow-hidden",
            f.findbar?.overflow === "hidden",
            f.findbar?.overflow,
        );
        const tr = f.findbarTopRight || {};
        add(
            "findbar-top-right-fits",
            tr.position === "absolute" &&
                tr.overflow === "hidden" &&
                tr.left >= 0 &&
                tr.right <= tr.windowWidth,
            `${tr.position}, ${tr.overflow}, ${tr.left}..${tr.right} of ${tr.windowWidth}`,
        );
        // A split view keeps the tab strip height and gives the wrapper a
        // tab's height (issue #6).
        const sv = f.splitView || {};
        add(
            "split-view-keeps-strip",
            sv.stripAfter !== null &&
                Math.abs(sv.stripAfter - sv.stripBefore) <= 1 &&
                Math.abs(sv.wrapper - sv.tab) <= 1,
            `strip ${sv.stripBefore} -> ${sv.stripAfter}, wrapper ${sv.wrapper} vs tab ${sv.tab}`,
        );
        // Tab groups: line under unselected tabs, a chip-sized label, and
        // collapsed tabs clipped (issue #16, edelvarden/material-fox-updated#129).
        const tg = f.tabGroup || {};
        // Nova off resolves the line colour to oklch(), which parseColor leaves
        // symbolic; any colour that is not transparent counts.
        const line = parseColor(tg.line);
        add(
            "tab-group-line-visible",
            !!tg.line &&
                tg.line !== "transparent" &&
                (line ? line.a > 0 : true),
            tg.line,
        );
        add(
            "tab-group-label-chip",
            tg.label !== null && tg.label <= 24,
            tg.label,
        );
        add(
            "tab-group-collapsed-clipped",
            tg.collapsedOverflow === "clip",
            tg.collapsedOverflow,
        );
        add(
            "tab-group-label-line-over-corners",
            Number(tg.labelLineZ) > Number(tg.selectedBackgroundZ),
            `label line z ${tg.labelLineZ}, selected tab z ${tg.selectedBackgroundZ}`,
        );
        add(
            "tab-group-collapsed-line-hidden",
            tg.collapsedLine === "none",
            tg.collapsedLine,
        );
        // Opt-in pinned-tab prefs (issue #16).
        const pp = f.pinnedPrefs || {};
        add(
            "pref:no-tab-title-changed-dot",
            !!pp.dotDefault && pp.dotDefault !== "none" && pp.dot === "none",
            `${String(pp.dotDefault).slice(0, 24)} -> ${pp.dot}`,
        );
        add("pref:no-pinned-tab-mute-click", pp.overlay === "none", pp.overlay);
        // The gap after the last pinned tab is the gap between other tabs,
        // and the first tab keeps its start margin without pinned tabs
        // (fork #21).
        const pg = f.pinnedGap || {};
        add(
            "pinned-tabs-gap-matches",
            pg.firstMarginNoPinned === 8 &&
                typeof pg.afterPinned === "number" &&
                Math.abs(pg.afterPinned - pg.between) <= 1,
            `no pinned: first margin ${pg.firstMarginNoPinned}, after pinned ${pg.afterPinned} vs between ${pg.between}`,
        );
        add(
            "pref:no-tab-audio-background-ring",
            pp.ringDefault?.any === true && pp.ring?.any === false,
            `default ${JSON.stringify(pp.ringDefault)}, pref ${JSON.stringify(pp.ring)}`,
        );
        // macOS only: background tab labels keep the pre-160 0.7 by default
        // (Firefox 160 made it 0.6), full strength with the pref, and pinned
        // favicons stay at 1 (Firefox 160 fades them to 0.8).
        const td = f.tabDimming;
        if (td?.platform === "macosx") {
            add(
                "pref:no-tab-dimming",
                td.default.label === "0.7" &&
                    td.default.pinnedIcon === "1" &&
                    td.pref.label === "1" &&
                    td.pref.pinnedIcon === "1",
                `default ${JSON.stringify(td.default)}, pref ${JSON.stringify(td.pref)}`,
            );
        }
        // Panel padding (issue #17 and #2).
        const pad = p.panelPadding || {};
        add(
            "panel:bookmark-editor-padded",
            pad.editBookmark > 0,
            pad.editBookmark,
        );
        add(
            "panel:notification-single-padding",
            !!pad.notification && !/\s/.test(pad.notification),
            pad.notification,
        );
        add(
            "panel:menu-padding-pair",
            !pad.menuThemed || pad.menu === "8px 0",
            pad.menu,
        );
        // Opt-in history badge pref (issue #18).
        const hb = f.historyBadge || {};
        add(
            "pref:no-urlbar-history-badge",
            // The badge is Nova-only; Proton has no mask to remove.
            (!p.nova || (!!hb.maskDefault && hb.maskDefault !== "none")) &&
                hb.mask === "none" &&
                hb.badge === "none",
            `${String(hb.maskDefault).slice(0, 28)} -> ${hb.mask}, badge ${hb.badge}`,
        );
    }

    if (scenarioId === "themed" || scenarioId === "themed-proton") {
        // Opt-in Chromium tab hover timing (edelvarden/material-fox-updated#147).
        const th = (p.features || {}).tabHover || {};
        add(
            "tab-hover-chromium-timing",
            th.hovered &&
                th.default !== "0.3s" &&
                th.rest === "0.3s" &&
                th.hover === "0.1s",
            `default ${th.default}, pref ${th.rest} -> hover ${th.hover} (hovered ${th.hovered})`,
        );
    }

    if (scenarioId === "themed" || scenarioId === "themed-proton") {
        // Opt-in themed Firefox pages (edelvarden/material-fox-updated#124).
        const tp = (p.features || {}).themedPages || {};
        add(
            "themed-pages-pref",
            !!tp.palette && tp.default !== tp.palette && tp.pref === tp.palette,
            `canvas ${tp.default} -> ${tp.pref} (palette ${tp.palette})`,
        );
    }

    if (
        scenarioId === "themed" ||
        scenarioId === "themed-proton" ||
        scenarioId === "chrome-refresh"
    ) {
        // With the List all tabs button moved before the tabs, Firefox's
        // divider before the tabs stays off, and under ui-chrome-refresh on
        // Windows/Linux (which orders the strip) the tabs start where they do
        // by default (fork #21).
        const ts = (p.features || {}).tabStripStart || {};
        const ordered =
            scenarioId === "chrome-refresh" && ts.platform !== "macosx";
        add(
            "tab-strip-start-button-first",
            !!ts.first &&
                (ts.first.separator === "none" ||
                    ts.first.separatorDisplay === "none") &&
                (!ordered || ts.first.firstTab === ts.default.firstTab),
            `first tab ${ts.default?.firstTab} -> ${ts.first?.firstTab}, divider ${ts.first?.separator}/${ts.first?.separatorDisplay}`,
        );
    }

    if (scenarioId === "themed" || scenarioId === "themed-proton") {
        // Opt-in tab counter (edelvarden/material-fox-updated#86).
        const tc = (p.features || {}).tabCounter || {};
        add(
            "tab-counter-pref",
            tc.default?.icon === "1" &&
                !String(tc.default?.content).includes("counter(") &&
                String(tc.pref?.content).includes("counter(mfox-tabs") &&
                tc.pref?.icon === "0",
            `default ${tc.default?.content} icon ${tc.default?.icon}, pref ${tc.pref?.content} icon ${tc.pref?.icon}`,
        );
        // The drawn number matches the open tabs wherever the button sits,
        // and only one copy shows (fork #21).
        const want = String(tc.tabs);
        add(
            "tab-counter-counts-tabs",
            tc.drawnDefault?.button === want &&
                tc.drawnDefault?.strip === null &&
                tc.drawnFirst?.button === null &&
                tc.drawnFirst?.strip === want,
            `${want} tabs: default button ${tc.drawnDefault?.button} strip ${tc.drawnDefault?.strip}, button first: button ${tc.drawnFirst?.button} strip ${tc.drawnFirst?.strip}`,
        );
    }

    if (scenarioId === "themed" || scenarioId === "themed-proton") {
        // Opt-in inactive titlebar colour (edelvarden/material-fox-updated#140).
        const it = (p.features || {}).inactiveTitlebar || {};
        add(
            "inactive-titlebar-pref-keeps-colour",
            it.inactive && it.default !== it.active && it.pref === it.active,
            `active ${it.active}, inactive ${it.default} -> pref ${it.pref}`,
        );
        // Firefox only fades the strip with tabs in the titlebar.
        if (it.customTitlebar)
            add(
                "inactive-titlebar-pref-keeps-opacity",
                it.inactive &&
                    Number(it.opacityDefault) < 1 &&
                    it.opacityPref === "1",
                `tab strip opacity inactive ${it.opacityDefault} -> pref ${it.opacityPref}`,
            );
        // Windows and Linux: macOS fades every toolbar button itself.
        if (it.customTitlebar && it.platform !== "macosx")
            add(
                "inactive-titlebar-pref-dims-new-tab",
                it.inactive &&
                    it.opacityPref === "1" &&
                    Number(it.newTabOpacityPref) < 1,
                `new tab button opacity ${it.newTabOpacityPref} (strip ${it.opacityPref})`,
            );
    }

    // Menus (Windows/Linux only, the probe skips them on macOS): one text
    // column and one row height per popup, one icon per nav item, and the
    // icons pref uses Firefox's gutter instead of adding its own
    // (edelvarden/material-fox-updated#150, #145, #135).
    const menus = (p.features || {}).menus;
    if ((scenarioId === "themed" || scenarioId === "themed-proton") && menus) {
        const textX = (m) => [
            ...new Set(m.rows.map((r) => r.textX).filter((x) => x !== null)),
        ];
        const heights = (m) => [...new Set(m.rows.map((r) => r.h))];
        // Rows off the popup's most common height, so a failure names them.
        const oddRows = (m) => {
            const count = {};
            for (const r of m.rows) count[r.h] = (count[r.h] || 0) + 1;
            const common = Object.keys(count).sort(
                (a, b) => count[b] - count[a],
            )[0];
            return m.rows
                .filter((r) => String(r.h) !== common)
                .map((r) => `${r.id || "?"}=${r.h}`);
        };
        for (const [name, m] of Object.entries(menus)) {
            const odd = oddRows(m);
            add(
                `menu-${name}-aligned`,
                m.rows.length > 0 &&
                    textX(m).length === 1 &&
                    heights(m).length === 1,
                `${m.rows.length} rows, text x ${textX(m)}, heights ${heights(m)}` +
                    (odd.length ? ` (${odd.join(", ")})` : ""),
            );
        }
        // One row height across popups, with or without the icon column.
        const allHeights = [
            ...new Set(Object.values(menus).flatMap((m) => heights(m))),
        ];
        add("menu-rows-one-height", allHeights.length === 1, allHeights);
        // Text starts at Firefox's padding, plus its icon column when the
        // popup has one: no extra indent of the theme's own.
        for (const [name, m] of Object.entries(menus)) {
            const insets = [
                ...new Set(
                    m.rows.map((r) => r.inset).filter((x) => x !== null),
                ),
            ];
            add(
                `menu-${name}-firefox-inset`,
                insets.length === 1 && insets[0] === 0,
                `extra indent ${insets}`,
            );
        }
        for (const name of ["page", "pageIcons"]) {
            const nav = menus[name].rows.filter((r) =>
                /^context-(back|forward|reload)/.test(r.id),
            );
            add(
                `menu-${name}-nav-one-icon`,
                nav.length === 3 && nav.every((r) => r.icon && !r.bgIcon),
                nav
                    .map((r) => `${r.id} icon ${r.icon} bg ${r.bgIcon}`)
                    .join(", "),
            );
        }
        const [plain] = textX(menus.tab);
        const [gutter] = textX(menus.toolbar);
        const [icons] = textX(menus.tabIcons);
        add(
            "menu-gutter-when-checked",
            menus.toolbar.gutter && gutter > plain,
            `needsgutter ${menus.toolbar.gutter}, text ${plain} -> ${gutter}`,
        );
        // With userChrome.ui-menu-icon-column the nav labels start where
        // the other rows' text does, which is where it starts with the icons
        // pref. Without it they don't (fork #21).
        const navLabels = (m) => [
            ...new Set(
                m.rows
                    .filter((r) => /^context-(back|forward|reload)/.test(r.id))
                    .map((r) => r.labelX),
            ),
        ];
        const [columnText] = textX(menus.pageColumn);
        const [iconsText] = textX(menus.pageIcons);
        const columnNav = navLabels(menus.pageColumn);
        add(
            "menu-icon-column-pref-aligns-labels",
            textX(menus.pageColumn).length === 1 &&
                columnText === iconsText &&
                columnNav.length === 1 &&
                Math.abs(columnNav[0] - columnText) <= 1,
            `text ${textX(menus.pageColumn)} (icons pref ${iconsText}), nav labels ${columnNav}, default nav ${navLabels(menus.page)} vs text ${textX(menus.page)}`,
        );
        add(
            "menu-icons-pref-uses-gutter",
            icons === gutter &&
                menus.tabIcons.rows.some((r) => r.icon) &&
                menus.tabIcons.rows.every((r) => !r.bgIcon),
            `text ${icons} (gutter ${gutter}), icons ${menus.tabIcons.rows.filter((r) => r.icon).length}`,
        );
    }

    if (["themed", "themed-proton", "chrome-refresh"].includes(scenarioId)) {
        // Vertical tabs drop the corner flares (upstream #141).
        const vt = (p.features || {}).verticalTab || {};
        add(
            "vertical-tab-no-flares",
            vt.orient === "vertical" &&
                vt.flare === "none" &&
                vt.bottomRadius !== "0px",
            `${vt.orient} flare ${vt.flare} radius ${vt.bottomRadius}`,
        );
        // The rest of the vertical strip (upstream #134).
        add(
            "vertical-tab-rows-aligned",
            vt.labelX?.length === 1 &&
                vt.separator === "none" &&
                vt.fontSizes?.[0] === vt.fontSizes?.[1],
            `label x ${vt.labelX}, separator ${vt.separator}, title / New Tab ${vt.fontSizes}`,
        );
        add(
            "vertical-pinned-fills-cell",
            vt.pinnedWidth > 40,
            `pinned tab ${vt.pinnedWidth}px`,
        );
        const vc = vt.collapsed || {};
        add(
            "vertical-collapsed-icons-centred",
            vc.expanded === false &&
                vc.iconOffsets?.every((o) => Math.abs(o) <= 1) &&
                vc.close === "none",
            `expanded ${vc.expanded}, offsets ${vc.iconOffsets}, close ${vc.close}`,
        );
    }

    if (["themed", "themed-proton", "chrome-refresh"].includes(scenarioId)) {
        // Toolbar spacing (fork issue #12).
        const ts = (p.features || {}).toolbarSpacing || {};
        add(
            "alltabs-centred-on-tab",
            typeof ts.allTabsOffset === "number" &&
                Math.abs(ts.allTabsOffset) <= 0.25,
            `${ts.allTabsOffset}${ts.allTabsCaption ? " (caption style, against the strip)" : ""}`,
        );
        add(
            "toolbar-edges-match-top",
            ts.top > 0 && ts.first === ts.top && ts.last === ts.top,
            `top ${ts.top}, first ${ts.first}, last ${ts.last}`,
        );
        add(
            "urlbar-gaps-match-top",
            ts.beforeUrlbar === ts.top && ts.afterUrlbar === ts.top,
            `top ${ts.top}, before ${ts.beforeUrlbar}, after ${ts.afterUrlbar}`,
        );
        add(
            "button-groups-keep-gap",
            ts.between > 0 &&
                ts.afterZoom === ts.between &&
                ts.afterEdit === ts.between,
            `between ${ts.between}, after zoom ${ts.afterZoom}, after edit ${ts.afterEdit}`,
        );
        add(
            "import-button-transition",
            String(ts.importTransition).includes("background-color"),
            ts.importTransition,
        );
        // Readable text on the accent colour in dark mode: the confirmation
        // hint and primary buttons (both were light on the light accent on
        // Windows/Linux, about 2:1).
        const at = (p.features || {}).accentText || {};
        const describe = (fg, bg) =>
            `${fg} on ${bg}, ${contrast(parseColor(fg), parseColor(bg))?.toFixed(2)}:1${at.dark ? "" : " (not dark)"}`;
        add(
            "dark:confirmation-hint-contrast",
            at.dark &&
                contrast(
                    parseColor(at.hintText),
                    parseColor(at.hintBackground),
                ) >= 4.5,
            describe(at.hintText, at.hintBackground),
        );
        add(
            "dark:primary-button-contrast",
            at.dark &&
                contrast(
                    parseColor(at.buttonText),
                    parseColor(at.buttonBackground),
                ) >= 4.5,
            describe(at.buttonText, at.buttonBackground),
        );
    }

    if (scenarioId === "chrome-refresh") {
        // The pinned tab gap, under ui-chrome-refresh as well (fork #21).
        const f = p.features || {};
        // The tab hover preview is centred under a full-width tab (fork #21).
        const tp = f.tabPreview || {};
        const previewOffset =
            tp.marginStart + tp.shadowMargin + tp.width / 2 - tp.tabMax / 2;
        add(
            "refresh:tab-preview-centred",
            tp.width > 0 && tp.tabMax > 0 && Math.abs(previewOffset) <= 0.5,
            `centre ${previewOffset} from the tab's (margin ${tp.marginStart}, shadow margin ${tp.shadowMargin}, panel ${tp.width}, tab ${tp.tabMax})`,
        );
        const pg = f.pinnedGap || {};
        add(
            "pinned-tabs-gap-matches",
            pg.firstMarginNoPinned === 8 &&
                typeof pg.afterPinned === "number" &&
                Math.abs(pg.afterPinned - pg.between) <= 1,
            `no pinned: first margin ${pg.firstMarginNoPinned}, after pinned ${pg.afterPinned} vs between ${pg.between}`,
        );
    }

    if (scenarioId === "chrome-refresh") {
        // Toolbar, extensions and new-tab icon boxes match, and a pinned tab's
        // icon is centred (issue #12, edelvarden/material-fox-updated#117).
        const f = p.features || {};
        const ic = f.icons || {};
        add("feature-probe", !f.error, f.error);
        add(
            "refresh:extensions-icon-matches",
            ic.back !== null && Math.abs(ic.extensions - ic.back) <= 1,
            `extensions ${ic.extensions} vs back ${ic.back}`,
        );
        add(
            "refresh:newtab-icon-matches",
            ic.back !== null && Math.abs(ic.newtab - ic.back) <= 1,
            `new tab ${ic.newtab} vs back ${ic.back}`,
        );
        add(
            "refresh:pinned-icon-centred",
            typeof ic.pinnedOffset === "number" &&
                Math.abs(ic.pinnedOffset) <= 0.5,
            ic.pinnedOffset,
        );
        const nc = f.navCorner || {};
        add(
            "refresh:navbar-corner-square-on-first-tab",
            nc.first === "0px" && !!nc.other && nc.other !== "0px",
            `first ${nc.first}, other ${nc.other}`,
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
            // Linux's native-theme tokens set --toolbar-field-text-color to
            // `inherit` on :root, which leaves it unset by design there.
            else if (k === "toolbarFieldText" && p.os === "Linux")
                add(`token-resolves:${k}`, true, val || "(unset, Linux)");
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
            const themed = scenario.themed !== false;
            // A launch that comes up without the theme is retried once with a
            // fresh profile, so it reports as a launch problem rather than as
            // every contract in the scenario failing.
            let p;
            let launchError;
            const missing = [];
            for (let attempt = 1; attempt <= 2; attempt++) {
                const profileDir = makeThemedProfile({
                    themed,
                    prefs: scenario.prefs,
                    label: "verify",
                });
                try {
                    console.error(
                        `\n[${channel}/${scenario.id}] launching (nova=${nova})${attempt > 1 ? `, attempt ${attempt}` : ""}...`,
                    );
                    p = await probe({
                        binary,
                        nova,
                        profileDir,
                        headless,
                        lwt: scenario.lwt,
                        features: FEATURE_SCENARIOS.has(scenario.id),
                        themed,
                    });
                } catch (err) {
                    launchError = err;
                    break;
                } finally {
                    rmSync(profileDir, {
                        recursive: true,
                        force: true,
                        maxRetries: 5,
                    });
                }
                if (!p.themeMissing) break;
                missing.push(p.themeMissing);
                console.error(
                    `  userChrome.css not applied: ${JSON.stringify(p.themeMissing)}`,
                );
            }
            if (launchError) {
                rows.push({
                    channel,
                    scenario: scenario.id,
                    name: "launch",
                    pass: false,
                    got: launchError.message,
                });
                failed++;
                continue;
            }
            if (themed) {
                const loaded = !p.themeMissing;
                rows.push({
                    channel,
                    scenario: scenario.id,
                    name: "theme-loaded",
                    pass: loaded,
                    got: `not applied in ${missing.length} launch(es), chrome dir: ${missing.at(-1)?.files || "(empty)"}`,
                });
                if (missing.length && loaded)
                    console.error(
                        `  [${channel}/${scenario.id}] theme applied on retry`,
                    );
                if (!loaded) {
                    failed++;
                    continue;
                }
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
