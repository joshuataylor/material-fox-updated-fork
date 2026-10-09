user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true); // for enable userChrome/userContent
user_pref("svg.context-properties.content.enabled", true); // for svg
user_pref("layout.css.color-mix.enabled", true); // for color-mix

// * Available preferences

// user_pref("userChrome.ui-chrome-refresh", true);

// * Color themes, use only one
// user_pref("userChrome.theme-chrome-refresh", true);
// user_pref("userChrome.theme-default", true);
// user_pref("userChrome.theme-material", true);

// * Force enable control animation, because by default respects the user animation disable preference.
// * (Not required if you do not disable animation)
// user_pref("userChrome.ui-force-animation", true);

// * Make the URL bar more compact by reducing its height
// user_pref("userChrome.ui-compact-url-bar", true);

// * Hide menu icons
// user_pref("userChrome.ui-no-menu-icons", true);

// * Remove the border, rounded corners and gap Firefox 155+'s "Nova" redesign
// * draws around the window, so the chrome sits flush to the window edges
// * (browser.nova.enabled, default on Nightly).
// user_pref("userChrome.ui-no-nova-border", true);

// * Changes the whole toolbox to be white instead of the default light-grey tint, so
// * the tab strip and toolbar framing match the white URL-bar/bookmarks rows
// * (all-white top chrome). Unselected tabs then rely on the active tab +
// * separators for distinction.
// user_pref("userChrome.ui-white-toolbox", true);

// * Move the find-in-page bar (Ctrl/Cmd+F) to the top-right corner of the
// * content area (its pre-"Nova" floating position) instead of the default
// * bottom dock. Works whether or not browser.nova.enabled is set.
// user_pref("userChrome.ui-findbar-top-right", true);

// * With the top-right find bar above, also hide its four toggle checkboxes
// * (Match Case / Match Diacritics / Whole Words / Highlight All) for a more
// * compact bar. Checkboxes are shown by default.
// user_pref("userChrome.ui-findbar-hide-checkboxes", true);

// * Hide the leading "Not Secure" chip on insecure (HTTP) pages for a minimal,
// * Chrome-like address bar. The secure (lock) indicator and breached-connection
// * warnings are always kept. Off by default -- the warning is a safety signal.
// user_pref("userChrome.ui-no-not-secure-warning", true);

// * Hide the clock badge on history results in the address bar dropdown, so
// * their site icons show in full. Off by default.
// user_pref("userChrome.ui-no-urlbar-history-badge", true);

// * Drop the circle behind the audio button on pinned tabs, leaving a plain
// * speaker icon. Off by default.
// user_pref("userChrome.ui-no-tab-audio-background", true);

// * Make the audio button on pinned tabs part of the tab, so clicking it
// * selects the tab instead of muting it. The tab context menu and Ctrl+M still
// * mute. Off by default.
// user_pref("userChrome.ui-no-pinned-tab-mute-click", true);

// * Hide the dot under an unselected pinned tab when its title changes (e.g.
// * new messages in a chat or mail tab). The dot for a tab waiting on a dialog
// * is kept. Off by default.
// user_pref("userChrome.ui-no-tab-title-changed-dot", true);

// * Chromium's tab hover timing: the hover colour comes in quickly (100ms)
// * and fades out slowly (300ms). Off by default.
// user_pref("userChrome.ui-chromium-tab-hover", true);

// * Keep the titlebar's colours when the window loses focus, instead of
// * turning grey (handy with a different theme colour per profile). Off by
// * default.
// user_pref("userChrome.ui-no-inactive-titlebar", true);

// * Show the number of open tabs on the "List all tabs" button. Off by
// * default.
// user_pref("userChrome.ui-tab-counter", true);

// * Changes the open/focused URL bar and its results dropdown to white, like Chrome's omnibox, instead of the material grey tint. false by default.
// user_pref("userChrome.ui-white-urlbar-results", true);
