// Base user_pref layer for scripts/firefox.mjs test profiles.
//
// Always applied first, as a --prefs <name> overlay (scripts/user_profiles/<name>.js)
// is merged on top, and the launcher sets browser.nova.enabled (from --nova) and
// the Marionette port (from --remote) last.
// Each entry becomes a user_pref() line in the profile's user.js, which the launcher regenerates every run.

export default {
    // Required for userChrome.css / userContent.css to load at all.
    "toolkit.legacyUserProfileCustomizations.stylesheets": true,
    // Theme rendering: SVG context-fill icons and color-mix() support.
    "svg.context-properties.content.enabled": true,
    "layout.css.color-mix.enabled": true,

    // Show a theme by default so a bare launch is not the unstyled default.
    "userChrome.theme-material": true,

    // Allow the sideloaded, unsigned Proton lightweight theme (see install-lwt).
    "xpinstall.signatures.required": false,
    "extensions.autoDisableScopes": 0,

    // Remote-debug-capable defaults (Marionette is only enabled via --remote).
    "marionette.port": 2828,
    "devtools.chrome.enabled": true,
    "devtools.debugger.force-local": true,
    "remote.log.level": "Info",
    "remote.log.truncate": false,

    // Quieter first run for a throwaway profile.
    "browser.aboutwelcome.enabled": false,
    "datareporting.policy.dataSubmissionEnabled": false,
    // Skip the "what's new" page after a version bump.
    "browser.startup.homepage_override.mstone": "ignore",
    // Skip the Firefox 158+ pre-onboarding Terms-of-Use splash
    // (browser.preonboarding.enabled gates it; bypassNotification acks the ToU),
    // so a bare launch lands straight on the browser.
    "browser.preonboarding.enabled": false,
    "termsofuse.bypassNotification": true,
    // Skip the "Proceed with Caution" interstitial on about:config.
    "browser.aboutConfig.showWarning": false,

    // Fewer nags in a throwaway profile (none of these change the themed chrome):
    "browser.shell.checkDefaultBrowser": false, // no "make default" prompt
    "app.update.auto": false, // no background update nags
    "browser.tabs.warnOnClose": false, // no "close N tabs?" dialog
    "browser.warnOnQuit": false,
    "signon.rememberSignons": false, // no save-password doorhanger
    "datareporting.healthreport.uploadEnabled": false,
    "browser.uitour.enabled": false, // no feature-tour highlights
    "browser.messaging-system.whatsNewPanel.enabled": false,
};
