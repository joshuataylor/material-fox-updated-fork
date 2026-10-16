#!/usr/bin/env node
// Captures Firefox's browser UI with Marionette and save PNGs.
// That's all I wanted. What follows is a weekend worth of digging into Selenium, GeckoDriver and Firefox's chrome context
// to get it working reliably across channels and colour schemes.
//
// Supports full-window and element screenshots across release channels (nightly/beta/stable) and colour schemes (light/dark).
//
// Also hides the automation indicator (striped URL bar and robot icon) before capture.
//
// Relevant documentation to help with understanding this mess:
//
// Firefox options, profiles and preferences: https://www.selenium.dev/documentation/webdriver/browsers/firefox/
// Browser navigation: https://www.selenium.dev/documentation/webdriver/interactions/navigation/
// Window and element screenshots: https://www.selenium.dev/documentation/webdriver/interactions/windows/#takescreenshot
// GeckoDriver system access: https://firefox-source-docs.mozilla.org/testing/geckodriver/Flags.html#allow-system-access
//
// Usage:
//   mise run screenshots # defaults from the config
//   mise run screenshots -- --channels nightly,beta --schemes light
//   mise run screenshots -- --only urlbar-not-secure
//   mise run screenshots -- --no-headless # visible window (debugging)
//
// Configure in scripts/screenshot.config.mjs, or use --config <path>.
// Use `variants: [{ id, prefs }]` for captures with different prefs. Variant prefs override the screenshot's prefs.
// Screenshots share a browser, with UI state reset between captures.
// Set `isolate: true` on a screenshot or the config to use a fresh profile for each capture that changes persistent state, such as bookmarks or history.
// Before capture the harness waits for the window to settle (see settle()). A shot can add `waitFor` selectors and a `minSettleMs` floor.
// Headless runs capture the schemes in parallel (--no-parallel to turn that off).
//
// PNGs output to `outDir` (default tmp/screenshots), named
// <feature>__<enabled|disabled>__<channel_major>__<light|dark>__<os>.png.
// For example: findbar_top_right__nightly_158__light__windows_11.png.

import { Builder, By, Key } from "selenium-webdriver";
import * as firefox from "selenium-webdriver/firefox.js";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { findBinary, NOVA_DEFAULT } from "./lib/firefox-bin.mjs";
import { makeThemedProfile } from "./lib/profile.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const BINARIES = {
    nightly: findBinary("nightly"),
    beta: findBinary("beta"),
    stable: findBinary("stable"),
};

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith("--")) continue;
        const key = token.slice(2);
        if (key.startsWith("no-")) {
            args[key.slice(3)] = false;
        } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
            args[key] = argv[++i];
        } else {
            args[key] = true;
        }
    }
    return args;
}

const list = (value) =>
    String(value)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Lowercase a filename segment and replace runs of punctuation or whitespace with "_".
const seg = (s) =>
    String(s)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");

// Combine the screenshot name, variant and aspect (crop label or "window").
// Omit the aspect if it repeats the name or variant: findbar + default + findbar becomes findbar_default.
function featureName(screenshotName, variant, aspect) {
    const parts = [seg(screenshotName)];
    if (variant) parts.push(seg(variant));
    const a = seg(aspect);
    if (a && !parts.includes(a)) parts.push(a);
    return parts.filter(Boolean).join("_");
}

// Include the toggle state, channel version, scheme and OS so captures can share
// one directory: <feature>__<enabled|disabled>__<version>__<scheme>__<os>.png.
function flatFile({
    outDir,
    screenshotName,
    variant,
    aspect,
    state,
    version,
    scheme,
    osTag,
}) {
    const feature = featureName(screenshotName, variant, aspect);
    return join(
        outDir,
        `${feature}__${state}__${version}__${scheme}__${osTag}.png`,
    );
}

// Read "<channel>_<major>" (e.g. "beta_156") from the running browser.
// Fall back to the channel name if the capabilities request fails.
async function readVersion(driver, channel) {
    try {
        const caps = await driver.getCapabilities();
        const v = String(
            caps.get("browserVersion") || caps.get("version") || "",
        );
        const major = (v.match(/\d+/) || ["0"])[0];
        return `${channel}_${major}`;
    } catch {
        return channel;
    }
}

// Detect the OS label for filenames, e.g. windows_11 or ubuntu_26_04.
// The caller checks --os and $SCREENSHOT_OS first.
function detectOs() {
    const p = process.platform;
    if (p === "darwin") {
        let v = "";
        try {
            v = execFileSync("sw_vers", ["-productVersion"], {
                encoding: "utf8",
            }).trim();
        } catch {
            /* ignore */
        }
        const major = (v.match(/\d+/) || [""])[0];
        return major ? `macos_${major}` : "macos";
    }
    if (p === "win32") {
        // os.release() -> "10.0.<build>"; Windows 11 is build >= 22000.
        const build = Number(os.release().split(".")[2] || 0);
        return build >= 22000 ? "windows_11" : "windows_10";
    }
    // Linux: ID + VERSION_ID from /etc/os-release, e.g. ubuntu_26_04.
    try {
        const txt = readFileSync("/etc/os-release", "utf8");
        const get = (k) =>
            (txt.match(new RegExp(`^${k}="?([^"\\n]+)`, "m")) || [])[1] || "";
        const id = get("ID");
        const ver = get("VERSION_ID");
        if (id && ver) return seg(`${id}_${ver}`);
    } catch {
        /* ignore */
    }
    return "linux";
}

// Convert a CSS selector to a crop label suitable for filenames.
const labelFor = (selector) =>
    selector
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "crop";

// Build one screenshot from --adhoc CLI flags.
// Capture the full window if no selector is supplied.
function buildAdhocScreenshot(args) {
    const selectors = args.selector ? list(args.selector) : [];
    let prefs;
    if (args.prefs) {
        try {
            prefs = JSON.parse(args.prefs);
        } catch (err) {
            throw new Error(`--prefs is not valid JSON: ${err.message}`);
        }
    }
    return {
        name: args.name || "adhoc",
        url: args.url || "about:blank",
        prefs,
        setup: args.setup || undefined,
        window: args.window === true || selectors.length === 0,
        crops: selectors.map((selector) => ({
            label: labelFor(selector),
            selector,
        })),
    };
}

async function loadConfig(configArg) {
    const path = configArg
        ? resolve(process.cwd(), configArg)
        : join(HERE, "screenshot.config.mjs");
    const mod = await import(pathToFileURL(path).href);
    return mod.default;
}

// Firefox options, profiles and preferences:
// https://www.selenium.dev/documentation/webdriver/browsers/firefox/
function buildOptions({ binary, profileDir, headless, nova, scheme, dpr }) {
    const options = new firefox.Options();
    options.addArguments("-no-remote", "-new-instance");
    if (headless) options.addArguments("-headless");
    options.setBinary(binary);
    options.setProfile(profileDir);

    // Use 2x resolution by default; override with --dpr.
    if (dpr && dpr !== 1) {
        options.setPreference("layout.css.devPixelsPerPx", String(dpr));
    }

    // Allow browser UI automation and access to Services.*.
    options.setPreference("marionette.allow-system-access", true);
    options.setPreference("remote.allow-system-access", true);
    options.setPreference("devtools.chrome.enabled", true);
    options.setPreference(
        "toolkit.legacyUserProfileCustomizations.stylesheets",
        true,
    );
    options.setPreference("browser.nova.enabled", nova);
    options.setPreference(
        "browser.newtabpage.activity-stream.nova.enabled",
        nova,
    );
    // Disable onboarding and data submission prompts in fresh profiles.
    options.setPreference("browser.aboutwelcome.enabled", false);
    options.setPreference("datareporting.policy.dataSubmissionEnabled", false);
    options.setPreference("browser.startup.homepage_override.mstone", "ignore");
    // Skip the Firefox 158+ pre-onboarding Terms-of-Use splash.
    options.setPreference("browser.preonboarding.enabled", false);
    options.setPreference("termsofuse.bypassNotification", true);
    // Suppress the startup default-browser / "pin to taskbar" prompt
    // (DefaultBrowserCheck.sys.mjs) so it does not overlay captures on Windows.
    options.setPreference("browser.shell.checkDefaultBrowser", false);
    // Hide overlay scrollbars straight away. macOS shows the page's scrollbar
    // for a moment after a load, and a quick capture would catch it.
    options.setPreference("ui.scrollbarFadeBeginDelay", 0);
    options.setPreference("ui.scrollbarFadeDuration", 0);
    // Set the system and page colour schemes.
    options.setPreference("ui.systemUsesDarkTheme", scheme === "dark" ? 1 : 0);
    options.setPreference(
        "layout.css.prefers-color-scheme.content-override",
        scheme === "dark" ? 0 : 1,
    );
    return options;
}

async function newDriver(options) {
    // GeckoDriver requires system access to automate Firefox's browser UI.
    // https://firefox-source-docs.mozilla.org/testing/geckodriver/Flags.html#allow-system-access
    const service = new firefox.ServiceBuilder().addArguments(
        "--allow-system-access",
    );
    const driver = await new Builder()
        .forBrowser("firefox")
        .setFirefoxOptions(options)
        .setFirefoxService(service)
        .build();
    await driver.setContext("chrome");
    return driver;
}

// Navigate the selected tab and wait for loading and UI updates.
// Use openTrustedLinkIn because gBrowser.loadURI can race the Marionette response and drop the connection.
// Standard WebDriver page navigation is documented here; this function runs in Firefox's chrome context:
// https://www.selenium.dev/documentation/webdriver/interactions/navigation/
async function navigate(driver, url) {
    await driver.executeScript((u) => {
        // eslint-disable-next-line no-undef
        openTrustedLinkIn(u, "current");
        return true;
    }, url);

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        const done = await driver.executeScript(() => {
            // eslint-disable-next-line no-undef
            const b = gBrowser.selectedBrowser;
            const uri = b?.currentURI?.spec || "";
            const loading = b?.webProgress?.isLoadingDocument;
            return uri !== "about:blank" && loading === false;
        });
        if (done) break;
        await sleep(50);
    }
}

// The longest setTimeout delay a setup script schedules (e.g. opening the find
// bar 300ms later), so settle() does not capture before it has run.
function timerDelay(code) {
    const delays = [
        ...String(code || "").matchAll(/setTimeout\([\s\S]*?,\s*(\d+)\s*\)/g),
    ].map((m) => Number(m[1]));
    return delays.length ? Math.max(...delays) : 0;
}

// Wait for the browser window to settle instead of a fixed delay: no CSS
// transition or finite animation still running, the crop targets showing and
// not moving between frames, every `waitFor` selector matching (UI that opens
// asynchronously, like the address bar results), and at least `minMs` gone.
// `maxMs` caps the wait, so an element that never shows costs what the old
// fixed delay did.
async function settle(driver, { selectors = [], waitFor = [], minMs, maxMs }) {
    await driver.executeAsyncScript(
        (selectors, waitFor, minMs, maxMs, done) => {
            /* global document, performance, requestAnimationFrame */
            const start = performance.now();
            const frame = () => new Promise((r) => requestAnimationFrame(r));
            const rect = (s) =>
                document.querySelector(s)?.getBoundingClientRect();
            const layout = () =>
                selectors
                    .map((s) => {
                        const r = rect(s);
                        return r
                            ? [r.x, r.y, r.width, r.height]
                                  .map(Math.round)
                                  .join()
                            : "none";
                    })
                    .join("|");
            const showing = () =>
                selectors.every((s) => rect(s)?.width && rect(s)?.height) &&
                waitFor.every((s) => document.querySelector(s));
            const animating = () =>
                document
                    .getAnimations()
                    .some(
                        (a) =>
                            a.playState === "running" &&
                            a.effect?.getComputedTiming().endTime !== Infinity,
                    );
            (async () => {
                let prev = null;
                let still = 0;
                while (performance.now() - start < maxMs) {
                    await frame();
                    const cur = layout();
                    still = cur === prev ? still + 1 : 0;
                    prev = cur;
                    if (
                        performance.now() - start >= minMs &&
                        still >= 2 &&
                        showing() &&
                        !animating()
                    )
                        break;
                }
                done(true);
            })();
        },
        selectors,
        waitFor,
        minMs,
        maxMs,
    );
}

// A window screenshot once two captures in a row match, which also covers
// changes inside the page (its own transitions, late badges) that the chrome
// window cannot see. Gives up after a few tries and keeps the last one.
async function stableScreenshot(driver) {
    let png = await driver.takeScreenshot();
    for (let i = 0; i < 4; i++) {
        await sleep(100);
        const next = await driver.takeScreenshot();
        if (next === png) return png;
        png = next;
    }
    return png;
}

async function setPrefs(driver, prefs) {
    if (!prefs) return;
    await driver.executeScript((entries) => {
        for (const [name, value] of entries) {
            if (typeof value === "boolean")
                Services.prefs.setBoolPref(name, value); // eslint-disable-line no-undef
            else if (typeof value === "number")
                Services.prefs.setIntPref(name, value); // eslint-disable-line no-undef
            else Services.prefs.setStringPref(name, String(value)); // eslint-disable-line no-undef
        }
        return true;
    }, Object.entries(prefs));
}

async function clearPrefs(driver, prefs) {
    if (!prefs) return;
    await driver.executeScript((names) => {
        for (const name of names) {
            try {
                Services.prefs.clearUserPref(name); // eslint-disable-line no-undef
            } catch {}
        }
        return true;
    }, Object.keys(prefs));
}

// Hide the striped toolbar and robot icon added by Marionette.
async function stripAutomationIndicator(driver) {
    await driver.executeScript(() => {
        document.documentElement.removeAttribute("remotecontrol");
        return true;
    });
}

function writePng(base64, outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, Buffer.from(base64, "base64"));
}

// Cut one element out of a full-display grab: its screen rectangle comes from
// Firefox (getOuterScreenRect() on popups and panels, which are their own OS
// windows), and a chrome-privileged canvas does the cropping, so the harness
// needs no image library. The grab's pixel size over the screen's CSS width
// gives the scale, which covers HiDPI displays.
async function cropFromScreen(driver, screenPng, crop, outPath) {
    const res = await driver.executeAsyncScript(
        (fileUrl, selector, pad, done) => {
            /* global document, screen, mozInnerScreenX, mozInnerScreenY, Image */
            const el = document.querySelector(selector);
            if (!el) return done({ error: `no element for ${selector}` });
            let rect;
            if (typeof el.getOuterScreenRect === "function") {
                rect = el.getOuterScreenRect();
            } else {
                const r = el.getBoundingClientRect();
                rect = {
                    x: mozInnerScreenX + r.left,
                    y: mozInnerScreenY + r.top,
                    width: r.width,
                    height: r.height,
                };
            }
            if (!rect.width || !rect.height)
                return done({ error: `${selector} is not showing` });
            const img = new Image();
            img.onload = () => {
                const scale = img.naturalWidth / screen.width;
                const x = Math.max(0, (rect.x - screen.left - pad) * scale);
                const y = Math.max(0, (rect.y - screen.top - pad) * scale);
                const w = Math.min(
                    img.naturalWidth - x,
                    (rect.width + 2 * pad) * scale,
                );
                const h = Math.min(
                    img.naturalHeight - y,
                    (rect.height + 2 * pad) * scale,
                );
                const canvas = document.createElementNS(
                    "http://www.w3.org/1999/xhtml",
                    "canvas",
                );
                canvas.width = Math.round(w);
                canvas.height = Math.round(h);
                canvas
                    .getContext("2d")
                    .drawImage(
                        img,
                        x,
                        y,
                        w,
                        h,
                        0,
                        0,
                        canvas.width,
                        canvas.height,
                    );
                done({ png: canvas.toDataURL("image/png").split(",")[1] });
            };
            img.onerror = () => done({ error: `could not load ${fileUrl}` });
            img.src = fileUrl;
        },
        pathToFileURL(screenPng).href,
        crop.selector,
        crop.pad ?? 16,
    );
    if (res?.error) {
        console.warn(
            `  ! crop "${crop.label}" from the screen failed: ${res.error}`,
        );
        return false;
    }
    writePng(res.png, outPath);
    return true;
}

// Grab the whole OS display via the platform's screen-capture tool. Needed for
// content-anchored popups (#PopupAutoComplete) that render as separate native
// windows and are therefore invisible to geckodriver's window/element
// screenshots -- a full-display grab is the only capture that includes them.
// macOS: screencapture; Windows: PowerShell (System.Drawing); Linux: an X11
// grabber (import/scrot/xwd -- present when the shot runs under Xvfb).
// Returns true on success; false (with a warning) if no tool is available.
function osFullScreenShot(outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    const run = (cmd, args) => {
        execFileSync(cmd, args, { stdio: "ignore" });
    };
    try {
        if (process.platform === "darwin") {
            run("screencapture", ["-x", outPath]);
            return true;
        }
        if (process.platform === "win32") {
            const ps = [
                "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
                "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;",
                "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;",
                "$g=[System.Drawing.Graphics]::FromImage($bmp);",
                "$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);",
                `$bmp.Save('${outPath.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png)`,
            ].join(" ");
            run("powershell", ["-NoProfile", "-Command", ps]);
            return true;
        }
        // Linux: needs an X display (Xvfb sets $DISPLAY); skip cleanly on the
        // headless pass where there is none.
        if (!process.env.DISPLAY) return false;
        // Try common X11 grabbers in order.
        for (const [cmd, args] of [
            ["import", ["-window", "root", outPath]],
            ["scrot", ["-o", outPath]],
            ["gnome-screenshot", ["-f", outPath]],
        ]) {
            try {
                run(cmd, args);
                return true;
            } catch {
                /* try the next tool */
            }
        }
        console.warn(
            "  ! full-screen capture: no X11 grabber found (install imagemagick or scrot)",
        );
        return false;
    } catch (err) {
        console.warn(`  ! full-screen capture failed: ${err.message}`);
        return false;
    }
}

// Run setup in chrome context, then wait for UI updates before capture.
// For example, setup can open the findbar with document.getElementById("cmd_find").doCommand().
async function runSetup(driver, setup) {
    if (!setup) return;
    await driver.executeScript(setup);
}

// Used when a web-content element needs to open a content-anchored chrome popup (e.g. the #PopupAutoComplete satchel/datalist dropdown).
async function runContentTrigger(driver, trigger) {
    if (!trigger) return;
    await driver.setContext("content");
    try {
        const el = await driver.findElement(By.css(trigger.selector));
        // Centre the field so a downward-opening popup has room (else it opens
        // off-screen and the crop grabs the page behind it).
        await driver.executeScript(
            "arguments[0].scrollIntoView({ block: 'center' });",
            el,
        );
        await el.click();
        if (trigger.type) await el.sendKeys(trigger.type);
        if (trigger.key) await el.sendKeys(Key[trigger.key]);
    } finally {
        await driver.setContext("chrome");
    }
    if (trigger.showPopup) {
        // The focused content input carries over the context switch; open its autocomplete popup from chrome (nsIFormFillController.showPopup).
        await driver.executeScript(() => {
            Cc["@mozilla.org/satchel/form-fill-controller;1"] // eslint-disable-line no-undef
                .getService(Ci.nsIFormFillController) // eslint-disable-line no-undef
                .showPopup();
            return true;
        });
    }
}

// Select the built-in theme matching the requested colour scheme.
// An active light or dark theme overrides ui.systemUsesDarkTheme for browser UI.
// This caused light captures to render dark on Firefox 156 beta...
async function enforceColorScheme(driver, scheme) {
    const themeId =
        scheme === "dark"
            ? "firefox-compact-dark@mozilla.org"
            : "firefox-compact-light@mozilla.org";
    await driver.executeAsyncScript((id, done) => {
        const { AddonManager } = ChromeUtils.importESModule(
            "resource://gre/modules/AddonManager.sys.mjs",
        );
        AddonManager.getAddonByID(id)
            .then((addon) => (addon ? addon.enable() : null))
            .then(
                () => done(true),
                () => done(false),
            );
    }, themeId);
    // Wait for the browser window to switch to the scheme.
    await driver.executeAsyncScript((dark, done) => {
        /* global matchMedia, performance */
        const mq = matchMedia("(prefers-color-scheme: dark)");
        const start = performance.now();
        const tick = () =>
            mq.matches === dark || performance.now() - start > 2000
                ? done(true)
                : setTimeout(tick, 20);
        tick();
    }, scheme === "dark");
}

// Reset UI state between captures: close findbars, panels and menus, leave split view, and keep one tab.
// Attempt each step even if an earlier one fails.
async function resetState(driver) {
    await driver.executeScript(() => {
        /* global gBrowser, gURLBar, document */
        const tryEach = (fns) =>
            fns.forEach((f) => {
                try {
                    f();
                } catch {}
            });
        tryEach([
            () =>
                document
                    .querySelectorAll("findbar")
                    .forEach((fb) => fb.close()),
            () => gBrowser.selectedTab.splitview?.unsplitTabs("reset"),
            () => gURLBar?.view?.close(),
            () => SidebarController?.hide(),
            () =>
                [
                    "editBookmarkPanel",
                    "appMenu-popup",
                    "tabContextMenu",
                    "contentAreaContextMenu",
                    "downloadsPanel",
                    "trustpanel-popup",
                    "protections-popup",
                ].forEach((id) => document.getElementById(id)?.hidePopup()),
            () => {
                for (let i = gBrowser.tabs.length - 1; i > 0; i--)
                    gBrowser.removeTab(gBrowser.tabs[i]);
                gBrowser.selectedTab = gBrowser.tabs[0];
            },
        ]);
        return true;
    });
}

// nameFor(aspect) supplies the output path for "window" or a crop label.
// Return the written files as { aspect, file }.
// WebDriver window and element screenshot APIs:
// https://www.selenium.dev/documentation/webdriver/interactions/windows/#takescreenshot
async function captureScreenshot(
    driver,
    screenshot,
    nameFor,
    settleMs,
    headless,
) {
    const written = [];
    // A full-display grab of a headless run would capture whatever is on the
    // desktop instead of Firefox (on a workstation, the user's own screen).
    if (screenshot.fullScreen && headless) {
        console.warn(
            `  ! "${screenshot.name}" needs a real display: run with --headful-only or --no-headless`,
        );
        return written;
    }
    await resetState(driver);
    await setPrefs(driver, screenshot.prefs);
    // A display grab only sees what is on the screen, so fill it with the
    // window first (popups near the edge of a too-big window were cut off).
    let restoreScale = null;
    if (screenshot.fullScreen) {
        // At 2x a 1080p display is only 540 CSS px tall, shorter than the app
        // menu, and Firefox squeezes a popup to fit the screen. Below 800 CSS
        // px of height, render this shot at the display's own scale instead.
        restoreScale = await driver.executeScript(() => {
            /* global screen */
            const pref = "layout.css.devPixelsPerPx";
            if (screen.availHeight >= 800) return null;
            const previous = Services.prefs.getCharPref(pref, "");
            Services.prefs.setCharPref(pref, "-1");
            return previous;
        });
        if (restoreScale !== null) await sleep(500);
        await driver.executeScript(() => {
            /* global window, screen */
            // Fill the screen's available area (below the macOS menu bar, above
            // the Windows taskbar), like macOS's Window > Fill. Not maximise:
            // that changes the window's sizemode, which the theme styles
            // differently (the tab strip's top margin). macOS reports a window
            // within about 4px of the visible frame as zoomed, so leave an 8px
            // margin, the same as Fill with "Tiled windows have margins".
            const inset = 8;
            window.resizeTo(
                screen.availWidth - 2 * inset,
                screen.availHeight - 2 * inset,
            );
            window.moveTo(screen.availLeft + inset, screen.availTop + inset);
            window.focus();
            // Keep popups open when focus moves: with no window manager
            // (Xvfb) focusing a field inside a panel moves X focus to the
            // popup window, and Firefox rolls the panel up as its window
            // deactivates (the bookmark editor closed 1ms after opening).
            Services.prefs.setBoolPref("ui.popup.disable_autohide", true);
            return true;
        });
        await sleep(300);
        const sizemode = await driver.executeScript(() =>
            document.documentElement.getAttribute("sizemode"),
        );
        if (sizemode !== "normal")
            console.warn(
                `  ! window is ${sizemode} after the fill, not normal: the tab strip will not match a normal window`,
            );
    }
    await navigate(driver, screenshot.url);
    await runSetup(driver, screenshot.setup);
    await runContentTrigger(driver, screenshot.contentTrigger);
    // One settle for all three steps, capped at what their fixed delays used
    // to add up to.
    const steps =
        1 + (screenshot.setup ? 1 : 0) + (screenshot.contentTrigger ? 1 : 0);
    await settle(driver, {
        selectors: (screenshot.crops || []).map((c) => c.selector),
        waitFor: [].concat(screenshot.waitFor || []),
        // A short floor for state that settles without animating, or the
        // shot's own `minSettleMs` for Firefox state that changes on a timer.
        minMs: Math.max(
            250,
            screenshot.minSettleMs ?? 0,
            timerDelay(screenshot.setup),
        ),
        maxMs: settleMs * steps,
    });
    await stripAutomationIndicator(driver);

    // Native-window popups are invisible to WebDriver screenshots; capture the
    // whole display from the OS instead. This is the only aspect for such a shot.
    if (screenshot.fullScreen) {
        // Re-strip and let the repaint land before the OS grab: opening the popup
        // can re-assert the `remotecontrol` attribute, and on Xvfb the striped
        // automation urlbar otherwise shows in the capture.
        await stripAutomationIndicator(driver);
        await sleep(500);
        const out = nameFor("fullscreen");
        if (osFullScreenShot(out)) {
            written.push({ aspect: "fullscreen", file: out });
            for (const crop of screenshot.crops || []) {
                if (crop.skipPlatforms?.includes(process.platform)) continue;
                const cropOut = nameFor(crop.label);
                if (await cropFromScreen(driver, out, crop, cropOut))
                    written.push({ aspect: crop.label, file: cropOut });
            }
        }
        await clearPrefs(driver, screenshot.prefs);
        await driver.executeScript((previous) => {
            Services.prefs.clearUserPref("ui.popup.disable_autohide");
            if (previous !== null)
                Services.prefs.setCharPref(
                    "layout.css.devPixelsPerPx",
                    previous,
                );
            return true;
        }, restoreScale);
        return written;
    }

    if (screenshot.window !== false) {
        const png = await stableScreenshot(driver);
        const out = nameFor("window");
        writePng(png, out);
        written.push({ aspect: "window", file: out });
    }

    for (const crop of screenshot.crops || []) {
        try {
            const el = await driver.findElement(By.css(crop.selector));
            const png = await el.takeScreenshot();
            const out = nameFor(crop.label);
            writePng(png, out);
            written.push({ aspect: crop.label, file: out });
        } catch (err) {
            console.warn(
                `  ! crop "${crop.label}" (${crop.selector}) failed: ${err.message}`,
            );
        }
    }

    await clearPrefs(driver, screenshot.prefs);
    return written;
}

// Expand each variant into a capture, with its prefs overriding the screenshot's.
// The variant ID becomes part of the filename. Without variants, capture once.
// `state` records whether this capture has the feature toggle on: "enabled" when
// the variant applies a pref, "disabled" for the baseline (empty prefs) or a
// variant-less screenshot. A variant may set `state` explicitly to override.
function expandScreenshot(screenshot) {
    if (!screenshot.variants?.length)
        return [{ screenshot, variant: null, state: "disabled" }];
    return screenshot.variants.map((v) => ({
        screenshot: {
            ...screenshot,
            prefs: { ...(screenshot.prefs || {}), ...(v.prefs || {}) },
        },
        variant: v.id,
        state:
            v.state ??
            (Object.keys(v.prefs || {}).length ? "enabled" : "disabled"),
    }));
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const config = await loadConfig(args.config);

    const adhoc = args.adhoc === true;
    // Accept --scheme as an alias for --schemes.
    const schemesArg = args.schemes ?? args.scheme;
    const dpr = args.dpr ? Number(args.dpr) : (config.dpr ?? 2);
    // Ad-hoc captures default to nightly and light unless overridden.
    const channels = args.channels
        ? list(args.channels)
        : adhoc
          ? ["nightly"]
          : config.channels;
    const schemes = schemesArg
        ? list(schemesArg)
        : adhoc
          ? ["light"]
          : config.schemes;
    const only = args.only ? new Set(list(args.only)) : null;
    const headfulOnly = args["headful-only"] === true;
    const headless = headfulOnly ? false : args.headless !== false;
    const outDir = resolve(process.cwd(), args.out || config.outDir);
    const osTag = args.os || process.env.SCREENSHOT_OS || detectOs();
    const settleMs = config.settleMs ?? 600;
    // Cache the browser version per channel for filenames.
    const versionByChannel = {};
    let screenshots = adhoc ? [buildAdhocScreenshot(args)] : config.screenshots;
    if (only) screenshots = screenshots.filter((s) => only.has(s.name));
    if (headfulOnly) screenshots = screenshots.filter((s) => s.headful);
    // Display grabs need a real display: leave them out of a headless run
    // with one note rather than a warning per shot.
    if (headless) {
        const grabs = screenshots.filter((s) => s.fullScreen);
        if (grabs.length) {
            screenshots = screenshots.filter((s) => !s.fullScreen);
            console.log(
                `Skipping ${grabs.length} display-grab shot(s) on a headless run (${grabs.map((s) => s.name).join(", ")}); use --headful-only or --no-headless for them.`,
            );
        }
    }

    if (!screenshots.length) {
        console.error("No screenshots selected.");
        process.exit(1);
    }

    const manifest = [];
    for (const channel of channels) {
        const binary = BINARIES[channel];
        if (!binary || !existsSync(binary)) {
            console.warn(
                `Skipping channel "${channel}": no binary (run: mise run firefox-download --channel ${channel}, or set $FF_${channel.toUpperCase()}).`,
            );
            continue;
        }
        const nova = args.nova ? args.nova === "on" : NOVA_DEFAULT[channel];
        // Create a temporary themed profile for this channel under tmp/profiles/.
        const profileDir = makeThemedProfile({
            prefs: { "userChrome.theme-material": true },
            label: "screenshot",
        });

        // One scheme's captures in its own browser. Returns its log lines and
        // manifest entries, so parallel schemes print in order.
        const runScheme = async (scheme, live) => {
            const lines = [];
            let pending = "";
            const write = (s) => {
                if (live) process.stdout.write(s);
                else pending += s;
            };
            const log = (s) => {
                if (live) console.log(s);
                else {
                    lines.push(pending + s);
                    pending = "";
                }
            };
            const entries = [];
            log(
                `\n[${channel}/${scheme}] (nova=${nova}, headless=${headless})...`,
            );
            // Selenium copies the profile for each launch. Apply the requested theme after startup.
            const launch = async () => {
                const options = buildOptions({
                    binary,
                    profileDir,
                    headless,
                    nova,
                    scheme,
                    dpr,
                });
                options.windowSize(config.window);
                // Now and then a launch comes up without userChrome.css
                // applied (the same flake verify-theme guards against), so
                // check for the sheet and relaunch.
                for (let attempt = 1; ; attempt++) {
                    const d = await newDriver(options);
                    const themed = await d.executeScript(() =>
                        InspectorUtils.getAllStyleSheets(document, false).some(
                            (s) =>
                                /\/chrome\/userChrome\.css$/i.test(
                                    s.href || "",
                                ),
                        ),
                    );
                    if (themed || attempt === 2) {
                        if (!themed)
                            console.warn(
                                `  ! ${channel}/${scheme}: userChrome.css did not load after a relaunch`,
                            );
                        await enforceColorScheme(d, scheme);
                        return d;
                    }
                    await d.quit().catch(() => {});
                }
            };

            // Reuse one browser unless the screenshot requires isolation.
            // Isolated captures get a fresh profile so bookmarks and history do not carry over.
            let shared = null;
            try {
                for (const screenshot of screenshots) {
                    for (const {
                        screenshot: s,
                        variant,
                        state,
                    } of expandScreenshot(screenshot)) {
                        const isolate = s.isolate ?? config.isolate ?? false;
                        const label = variant
                            ? `${screenshot.name}/${variant}`
                            : screenshot.name;
                        write(
                            `  - ${label}${isolate ? " [isolated]" : ""} ... `,
                        );
                        let driver;
                        if (isolate) driver = await launch();
                        else driver = shared ?? (shared = await launch());
                        if (!versionByChannel[channel])
                            versionByChannel[channel] = await readVersion(
                                driver,
                                channel,
                            );
                        const version = versionByChannel[channel];
                        const nameFor = (aspect) =>
                            flatFile({
                                outDir,
                                screenshotName: screenshot.name,
                                variant,
                                aspect,
                                state,
                                version,
                                scheme,
                                osTag,
                            });
                        try {
                            const written = await captureScreenshot(
                                driver,
                                s,
                                nameFor,
                                settleMs,
                                headless,
                            );
                            log(`${written.length} file(s)`);
                            for (const w of written)
                                entries.push({
                                    feature: featureName(
                                        screenshot.name,
                                        variant,
                                        w.aspect,
                                    ),
                                    state,
                                    channel,
                                    version,
                                    scheme,
                                    os: osTag,
                                    aspect: w.aspect,
                                    file: w.file,
                                });
                        } catch (err) {
                            log(`error: ${err.message}`);
                        } finally {
                            if (isolate) await driver.quit().catch(() => {});
                        }
                    }
                }
            } finally {
                if (shared) await shared.quit().catch(() => {});
            }
            return { lines, entries };
        };

        try {
            // Headless schemes are independent browsers, so run them side by
            // side. Display grabs share the screen, so a headful run stays one
            // at a time (as does --no-parallel).
            const parallel =
                headless && args.parallel !== false && schemes.length > 1;
            if (parallel) {
                const results = await Promise.all(
                    schemes.map((scheme) => runScheme(scheme, false)),
                );
                for (const { lines, entries } of results) {
                    for (const line of lines) console.log(line);
                    manifest.push(...entries);
                }
            } else {
                for (const scheme of schemes)
                    manifest.push(...(await runScheme(scheme, true)).entries);
            }
        } finally {
            rmSync(profileDir, { recursive: true, force: true });
        }
    }

    const manifestPath = join(outDir, "manifest.json");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    console.log(
        `\nDone. ${manifest.length} screenshot(s). Manifest: ${manifestPath}`,
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
