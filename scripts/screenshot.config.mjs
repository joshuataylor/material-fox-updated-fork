// Screenshots for `mise run screenshots` (see scripts/screenshot.mjs).
//
// Each screenshot is captured for every requested channel and scheme.
// A screenshot produces:
//   - one full-window PNG (unless `window: false`)
//   - one PNG per entry in `crops` (cropped element screenshots)
// A screenshot with `variants: [{ id, prefs }]` is captured once per variant (the variant's prefs merged over the screenshot's,
// then cleared), output nested under `<screenshot>/<id>/`.
//
// This set aims to cover the documented `userChrome.ui-*` toggles and their notable variations, so a browser update's effect
// on each themed feature is visible in one run.
//
// Not captured here (not a static-screenshot concern):
// ui-no-ripple, ui-no-animation / ui-force-animation (animation), ui-system-font (font swap, Windows).
// The mutually-exclusive theme-* colour schemes are left to the base profile (theme-material), as switching them mid-session is buggy.
//
// `prefs` are applied (via Services.prefs) BEFORE the screenshot's page loads and reset between screenshots/variants.
// userChrome.* toggles are -moz-bool-pref-gated, so they re-render live.
// Some toggles depend on an OS (e.g. macOS only, Windows only), so other OS screenshots just show the default.

const HTTPS_OFF = {
    "dom.security.https_first": false,
    "dom.security.https_only_mode": false,
    "dom.security.https_first_pbm": false,
};

// Local widget/input testbed shipped alongside this config. Resolved to a file://
// URL so it works on any machine and in CI without a network dependency.
const TESTBED_URL = new URL("./input-test.html", import.meta.url).href;

export default {
    outDir: "tmp/screenshots",
    window: { width: 1280, height: 800 },
    dpr: 2, // device-pixel ratio; 2 = crisp Retina-quality PNGs. Override with --dpr.
    channels: ["nightly"], // default; override with --channels
    schemes: ["light", "dark"], // override with --schemes (or --scheme)
    settleMs: 1000, // per-screenshot settle time (ms) after load, before capture

    screenshots: [
        {
            // Baseline top chrome, no toggles -- the reference every other screenshot departs from.
            name: "overview",
            url: "https://example.com/",
            crops: [{ label: "toolbox", selector: "#navigator-toolbox" }],
        },
        {
            // Address bar: default height vs userChrome.ui-compact-url-bar.
            name: "urlbar",
            url: "https://example.com/",
            window: false,
            crops: [
                { label: "urlbar", selector: "#urlbar-container" },
                { label: "navbar", selector: "#nav-bar" },
            ],
            variants: [
                { id: "default", prefs: {} },
                {
                    id: "compact",
                    prefs: { "userChrome.ui-compact-url-bar": true },
                },
            ],
        },
        {
            // Leading "Not Secure" chip on an HTTP page vs ui-no-not-secure-warning.
            name: "urlbar-not-secure",
            url: "http://httpforever.com/",
            window: false,
            prefs: HTTPS_OFF,
            crops: [{ label: "urlbar", selector: "#urlbar-container" }],
            variants: [
                { id: "default", prefs: {} },
                {
                    id: "hidden",
                    prefs: { "userChrome.ui-no-not-secure-warning": true },
                },
            ],
        },
        {
            // Tab strip. mac-window-controls renders traffic-light buttons by the tabs
            // on Windows/Linux (no-op on macOS, so that capture matches default).
            name: "tabbar",
            url: "https://example.com/",
            window: false,
            crops: [{ label: "tabs", selector: "#TabsToolbar" }],
            variants: [
                { id: "default", prefs: {} },
                {
                    id: "mac-window-controls",
                    prefs: { "userChrome.ui-mac-window-controls": true },
                },
            ],
        },
        {
            // Whole top chrome across the framing/layout toggles.
            name: "toolbox",
            url: "https://example.com/",
            window: false,
            crops: [{ label: "toolbox", selector: "#navigator-toolbox" }],
            variants: [
                { id: "default", prefs: {} },
                {
                    id: "white-toolbox",
                    prefs: { "userChrome.ui-white-toolbox": true },
                },
                {
                    id: "chrome-refresh",
                    prefs: { "userChrome.ui-chrome-refresh": true },
                },
                {
                    id: "chrome-refresh-old-icons",
                    prefs: {
                        "userChrome.ui-chrome-refresh": true,
                        "userChrome.ui-force-old-icons": true,
                    },
                },
            ],
        },
        {
            // Full window so the Nova window/content border + corners are visible.
            // ui-no-nova-border for browser.nova.enabled (nightly default).
            name: "window-border",
            url: "https://example.com/",
            variants: [
                { id: "default", prefs: {} },
                {
                    id: "no-nova-border",
                    prefs: { "userChrome.ui-no-nova-border": true },
                },
            ],
        },
        {
            // Findbar across userChrome.ui-findbar-* toggles.
            // Each variant reopens the bar with the matching prefs; the crop targets the open findbar.
            name: "findbar",
            url: "https://example.com/",
            setup: 'document.getElementById("cmd_find").doCommand();',
            window: false,
            crops: [{ label: "findbar", selector: "findbar:not([hidden])" }],
            variants: [
                { id: "default", prefs: {} },
                {
                    id: "hide-checkboxes",
                    prefs: { "userChrome.ui-findbar-hide-checkboxes": true },
                },
                {
                    id: "top-right",
                    prefs: { "userChrome.ui-findbar-top-right": true },
                },
                {
                    id: "top-right-compact",
                    prefs: {
                        "userChrome.ui-findbar-top-right": true,
                        "userChrome.ui-findbar-hide-checkboxes": true,
                    },
                },
            ],
        },
        {
            // Tab context menu: icons off (default) vs userChrome.ui-context-menu-icons.
            // Also keep the full window in case the menupopup renders in an OS window (macOS) where the element crop comes back empty.
            name: "context-menu",
            headful: true, // native menu / anchored -- needs a real display
            url: "https://example.com/",
            setup:
                'const m = document.getElementById("tabContextMenu"); ' +
                'm.openPopup(gBrowser.selectedTab, "after_start", 0, 0, true, false); ' +
                "return true;",
            crops: [{ label: "menu", selector: "#tabContextMenu" }],
            variants: [
                { id: "default", prefs: {} },
                {
                    id: "icons",
                    prefs: { "userChrome.ui-context-menu-icons": true },
                },
            ],
        },
        {
            // App ("hamburger") menu: icons shown (default) vs userChrome.ui-no-menu-icons.
            name: "app-menu",
            headful: true, // anchored panel -- needs a real display
            url: "https://example.com/",
            setup: "PanelUI.show(); return true;",
            crops: [{ label: "menu", selector: "#appMenu-popup" }],
            variants: [
                { id: "default", prefs: {} },
                {
                    id: "no-icons",
                    prefs: { "userChrome.ui-no-menu-icons": true },
                },
            ],
        },

        {
            // Content autofill popup (#PopupAutoComplete) over a dark webpage.
            //
            // Capture caveat: the popup is a native OS window that Firefox's own takeScreenshot cannot see it on macOS
            name: "autocomplete-popup",
            headful: true,
            isolate: true,
            url: TESTBED_URL,
            contentTrigger: {
                selector: 'input[list="group-tags"]',
                type: "a",
                showPopup: true,
            },
            crops: [{ label: "popup", selector: "#PopupAutoComplete" }],
        },

        // --- Nova / Firefox 156+ features (regression coverage) ---

        // Nova's window/tab/urlbar rendering itself is regression-tested by the channel matrix:
        // nightly captures are nova-on, beta/stable nova-off, so the
        // same screenshots above show both. window-border covers the Nova border toggle.
        {
            // Revamped sidebar (155+): the theme styles the sidebar panel and border.
            name: "sidebar",
            url: "https://example.com/",
            setup: 'SidebarController.show("viewBookmarksSidebar"); return true;',
            window: false,
            crops: [{ label: "sidebar", selector: "#sidebar-box" }],
        },
        {
            // Vertical tabs (155+ sidebar revamp). The prefs may need the profile
            // relaunched to fully lay out; best-effort full-window capture. Isolated so
            // the sidebar-revamp prefs do not bleed into other screenshots.
            name: "vertical-tabs",
            url: "https://example.com/",
            isolate: true,
            prefs: { "sidebar.revamp": true, "sidebar.verticalTabs": true },
        },
        {
            // New tab page chrome -- Nova 158 renders the search box with <moz-urlbar>
            // (gated by browser.urlbar.newtab.featureGate). Full window.
            name: "newtab",
            url: "about:newtab",
        },
        {
            // Bookmarks toolbar.
            name: "bookmarks-toolbar",
            url: "https://example.com/",
            prefs: { "browser.toolbars.bookmarks.visibility": "always" },
            window: false,
            crops: [{ label: "toolbar", selector: "#PersonalToolbar" }],
        },
        {
            // Downloads panel.
            // Anchored toolbar-button panels do not reliably paint under headless (they open off-screen / lose focus..),
            // so this is a full-window screenshot, run with `--no-headless` to actually see the panel.
            // @todo figure out
            name: "downloads-panel",
            headful: true, // anchored panel -- needs a real display
            url: "https://example.com/",
            setup: "DownloadsPanel.showPanel(); return true;",
        },
        {
            // Trust / site-information panel from the urlbar (Nova trust panel, 156+;
            // browser.urlbar.trustPanel.featureGate).
            // Anchored panel. headless issue, run with --no-headless for the open panel.
            name: "trust-panel",
            headful: true, // anchored panel -- needs a real display
            url: "https://example.com/",
            setup:
                'document.getElementById("trust-icon-container")?.click() ?? ' +
                'document.getElementById("tracking-protection-icon-container").click(); ' +
                "return true;",
        },
        {
            // Firefox View (about:firefoxview) -- the recents / open-tabs page.
            // Themed via userContent + the firefox-view-button in chrome. Full window.
            name: "firefox-view",
            url: "about:firefoxview",
        },
        {
            // Customize mode: the toolbar-customization palette over themed chrome.
            // Isolated, the customize state is large and must not bleed into other screenshots (resetState does not exit it).
            name: "customize-mode",
            url: "https://example.com/",
            isolate: true,
            setup: "gCustomizeMode.enter(); return true;",
        },
        {
            // Unified extensions panel (the puzzle-piece button, 111+).
            // Anchored panel, so full-window only (headless issues). `--no-headless` shows the panel.
            name: "unified-extensions",
            headful: true, // anchored panel -- needs a real display
            url: "https://example.com/",
            setup: "gUnifiedExtensions.togglePanel(); return true;",
        },
        {
            // Open URL bar + results dropdown. Covers ui-white-urlbar-results,
            // which whitens the field and the .urlbarView results surface.
            // Querying "example" surfaces the just-loaded example.com history row,
            // so the dropdown has content without network. The full-window shot
            // captures the dropdown (a separate surface on Nova); the crop is the
            // field.
            name: "urlbar-open",
            url: "https://example.com/",
            setup: 'gURLBar.focus(); gURLBar.value = "example"; gURLBar.startQuery({ searchString: "example" }); return true;',
            crops: [{ label: "urlbar", selector: "#urlbar" }],
            variants: [
                { id: "default", prefs: {} },
                {
                    id: "white-results",
                    prefs: { "userChrome.ui-white-urlbar-results": true },
                },
            ],
        },
        {
            // Private browsing page (userContent, _privatebrowsing.scss). Full window.
            name: "private-browsing",
            url: "about:privatebrowsing",
        },
        {
            // Classic menu bar (File/Edit/View...), hidden by default. Reveal it,
            // then crop. Windows/Linux only -- macOS uses the native menu bar, so
            // #toolbar-menubar is empty there and the crop soft-fails.
            name: "menu-bar",
            url: "https://example.com/",
            setup: 'document.getElementById("toolbar-menubar").removeAttribute("autohide"); return true;',
            window: false,
            crops: [{ label: "menubar", selector: "#toolbar-menubar" }],
        },
        {
            // Overflowing tab strip -> scroll arrows + the all-tabs (v) button.
            // Isolated: opens ~40 tabs, which must not leak into other screenshots.
            name: "tab-overflow",
            url: "https://example.com/",
            isolate: true,
            setup:
                "const p = Services.scriptSecurityManager.getSystemPrincipal(); " +
                'for (let i = 0; i < 40; i++) gBrowser.addTab("about:blank", { triggeringPrincipal: p }); ' +
                "return true;",
            window: false,
            crops: [{ label: "tabs", selector: "#TabsToolbar" }],
        },
        {
            // Star -> Edit Bookmark panel (#editBookmarkPanel). Isolated (adds a
            // bookmark). Anchored panel: full-window only under headless (opens
            // off-screen); --no-headless shows the panel.
            name: "edit-bookmark",
            headful: true, // anchored panel -- needs a real display
            url: "https://example.com/",
            isolate: true,
            setup:
                'document.getElementById("star-button-box")?.click() ?? ' +
                'document.getElementById("star-button").click(); ' +
                "return true;",
        },
        {
            // Split View tab container (155+).
            name: "split-view",
            url: "https://example.com/",
            isolate: true,
            setup:
                'const t = gBrowser.addTrustedTab("about:blank"); ' +
                "gBrowser.addTabSplitView([gBrowser.selectedTab, t], " +
                '{ insertBefore: gBrowser.selectedTab, trigger: "keyboard_shortcut" }); ' +
                "gBrowser.selectedTab = t; return true;",
            crops: [{ label: "tabs", selector: "#tabbrowser-tabs" }],
        },
    ],
};
