<h1 align="center">
  🦊 MaterialFox UPDATED (Fork maintained by @joshuataylor)
</h1>

<h2 align="center">
  A Firefox user CSS theme that looks similar to Chrome.
</h2>

> [!NOTE]
> This is a fork of the fantastic [MaterialFox UPDATED](https://github.com/edelvarden/material-fox-updated) by [edelvarden](https://github.com/edelvarden). Full credit for the original theme goes to them -- this fork exists to continue maintenance and updates.

> [!NOTE]
> Firefox's "Nova" redesign is on by default in every channel from Firefox 157 (Release, Beta and Nightly) and changes how the window, tabs, address bar, find bar and new-tab search box look. This theme adapts to it -- see [Firefox 155 "Nova" redesign](#firefox-155-nova-redesign) below.

![preview](docs/assets/preview.png)

## Supported Firefox versions

Only the current Firefox **Release**, **Beta** and **Nightly** are supported. Nightly is best effort: the Nova redesign and Firefox's browser-chrome markup change there every build, so a Nightly update can break things before this theme catches up.

> [!TIP]
> See https://whattrainisitnow.com for the latest Firefox releases.

As of 2026-10-09 (this will get quickly out of date, so check above...)

<table>
  <tr>
    <th>Channel</th>
    <th>Version</th>
    <th>Support</th>
  </tr>
  <tr>
    <td>Release</td>
    <td>Firefox 158</td>
    <td>Supported</td>
  </tr>
  <tr>
    <td>Beta</td>
    <td>Firefox 159</td>
    <td>Supported</td>
  </tr>
  <tr>
    <td>Nightly</td>
    <td>Firefox 160</td>
    <td>Best effort</td>
  </tr>
</table>

Firefox moved to a two-week release cycle with Firefox 155, so these numbers move quickly; the theme tracks whatever the latest three are. If something breaks after a Firefox update, please [open an issue](https://github.com/joshuataylor/material-fox-updated-fork/issues) with the exact Firefox version and channel.

> Firefox 120-154 is not supported. For Firefox 119 or below, the pinned `v1.0.7` release still works -- see the install-script note below.

## 🚀 Getting Started

To start using MaterialFox UPDATED, follow these steps:

1. **Open** Firefox and type `about:config` in the address bar, then press <kbd>Enter</kbd>.
2. If a warning page appears, **click** `Accept the Risk and Continue` to access the `about:config` page.
3. **Search** for the following preferences using the search bar at the top of the `about:config` page, and **ensure** the following preferences are `true`:

   - `toolkit.legacyUserProfileCustomizations.stylesheets`
   - `svg.context-properties.content.enabled`

4. **Type** `about:support` in the address bar and press <kbd>Enter</kbd>.
5. **Scroll down** to the `Profile Folder` section and **click** `Open Folder`.
6. **Download** the `chrome.zip` file from the [**latest release**](https://github.com/joshuataylor/material-fox-updated-fork/releases/latest). Use the `chrome.zip` release asset, not GitHub's "Source code" ZIP.
7. **Extract** the contents of `chrome.zip` into your Firefox profile directory, so that you end up with `[profile]/chrome/userChrome.css` and `[profile]/chrome/userContent.css`.
8. **Restart** Firefox to apply the changes.

> [!TIP]
> To update, back up `chrome/custom.css` (and anything else you've changed), replace the rest of the `chrome` folder with the new release, then restart Firefox. Keeping your own rules in `custom.css` makes this painless.

### Installation Script (for Advanced Users)

As an alternative to manual installation, you can use a PowerShell script.

> [!NOTE]
> The script asks which Firefox profile to use, then installs `chrome.zip` and the example `user.js` from the same release of this fork. It asks before overwriting an existing `chrome` folder or `user.js`. Older pinned tags that were only published upstream (such as `tags/v1.0.7`) are fetched from [edelvarden/material-fox-updated](https://github.com/edelvarden/material-fox-updated).

For **Windows**, run the following PowerShell command:

```powershell
$env:MATERIAL_FOX_VERSION = "latest"; PowerShell -ExecutionPolicy Unrestricted -c "iwr https://raw.githubusercontent.com/joshuataylor/material-fox-updated-fork/main/install.ps1 -useb | iex"
```

For Firefox version **119** or below (Firefox ESR, Floorp or Waterfox)

```powershell
$env:MATERIAL_FOX_VERSION = "tags/v1.0.7"; PowerShell -ExecutionPolicy Unrestricted -c "iwr https://raw.githubusercontent.com/joshuataylor/material-fox-updated-fork/main/install.ps1 -useb | iex"
```

## Firefox 155 "Nova" redesign

Firefox 155 introduced a large visual redesign codenamed Project Nova, behind `browser.nova.enabled` in `about:config`.

It was Nightly-only at first, and has been on by default in every channel since Firefox 157 (Bug 2056186), so Release users get it too. You can still turn it off with `browser.nova.enabled` set to `false`; the theme supports both.

Firefox 156 to 160 continue Nova rather than redesign it again. Firefox 157 also rebuilt the address bar (the results list is now its own popover below the input).

Nova restyles tabs, menus and panels, adds a warmer "fire" colour palette and an active-tab glow, and draws borders and rounded corners around the toolbar, sidebar and web content.

### material-fox-updated Nova workarounds

To account for these changes, material-fox-updated tries to work around these new quirks.

- Window / content border - Firefox 155 wraps the toolbar, sidebar and content in a floating "island" -- a 1px border with rounded corners, plus a gap inset from the window edges. Firefox 156+ drops the gap and only borders the content area and sidebar on the edges that face other chrome. Enable the `userChrome.ui-no-nova-border` preference (see [Available preferences](#available-preferences)) to remove those borders and rounded corners so the content and sidebar sit flush. The separator under the toolbars and the dividers between split-view panels stay. Off by default, and it only acts while Nova is enabled.
- Find bar - Firefox 155+ moved the find bar into a CSS grid at the bottom of the content area on every channel (not just Nova). The theme handles this automatically -- no action needed.
> Prefer the old top-right floating find bar? Enable the `userChrome.ui-findbar-top-right` preference (see [Available preferences](#available-preferences)). (Thanks to [zerix on Reddit](https://www.reddit.com/r/FirefoxCSS/comments/1w50dgs/comment/p7de6ug) and [SKDemon820's tweaks](https://github.com/edelvarden/material-fox-updated/issues/152#issuecomment-5544742129))!
- New-tab search box - Firefox Nightly (158+) replaces the new-tab search box with the address bar component (`<moz-urlbar>`); Release and Beta still use the old box. The theme styles both.

### More Nova-related notes

A couple of things worth knowing:

- Do not confuse `browser.nova.enabled` (the whole-browser redesign) with `browser.newtabpage.activity-stream.nova.enabled`, which only affects the new-tab page.
- Nova is under active development in Nightly and changes frequently. If something looks off after a Nightly update, please [open an issue](https://github.com/joshuataylor/material-fox-updated-fork/issues).

For more information, see:

- [Try the New Firefox Design in Nightly](https://blog.nightly.mozilla.org/2026/07/27/new-firefox-design/) -- Mozilla Nightly blog (2026-07-27)
- [This is the new Firefox design](https://blog.mozilla.org/en/firefox/new-firefox-design/) -- Mozilla blog (Project Nova announcement)
- [These Weeks in Firefox](https://blog.nightly.mozilla.org/) -- Mozilla Nightly blog (running changelog)
- Bugzilla: [Bug 2049244](https://bugzilla.mozilla.org/show_bug.cgi?id=2049244) (find bar moved into the `.browserContainer` CSS grid) and [Bug 2023711](https://bugzilla.mozilla.org/show_bug.cgi?id=2023711) (Nova styles for floating chrome and sidebar)

## 💖 Support & Suggestions

If you enjoy this project and want to help [@edelvarden](https://github.com/edelvarden) maintain it further, buying them a coffee would be greatly appreciated! [☕️](https://ko-fi.com/edelvarden)

<a href='https://ko-fi.com/edelvarden' target='_blank'><img height='36' style='border:0px;height:36px;' src='https://storage.ko-fi.com/cdn/kofi3.png?v=3' border='0' alt='Buy Me a Coffee at ko-fi.com' /></a>

> [!IMPORTANT]
> This fork, [material-fox-updated-fork](https://github.com/joshuataylor/material-fox-updated-fork), is maintained by [@joshuataylor](https://github.com/joshuataylor), and I'm fortunate to be able to maintain
> this project in my spare time. If you do enjoy this project, please buy [@edelvarden a coffee](https://ko-fi.com/edelvarden), and not me 🙌.

Your **suggestions** and **bug reports** are also welcome on [GitHub Issues](https://github.com/joshuataylor/material-fox-updated-fork/issues). For a bug, include your Firefox version and channel, the theme version, your operating system, the `userChrome.*` preferences you have enabled, and a screenshot.

## 🎨 Manual Customization

You can **apply** visual design changes by adding some `about:config` customization options (preferences).

To **set** a preference, **type** `about:config` in the address bar and press <kbd>Enter</kbd>.

To **enable** a preference:

1. **Create** a custom boolean preference by typing the preference name and **clicking** the plus button. For example, `userChrome.ui-chrome-refresh` enables the new Chrome design.

To **disable** a preference:

1. **Search** for it by name and **delete** the preference or toggle its state to `false`.

> [!WARNING]  
> Use only one preference with the prefix `theme`.

Leave all the `userChrome.theme-*` preferences off to use the theme's bundled palette. `userChrome.theme-chrome-refresh` only changes the colours and `userChrome.ui-chrome-refresh` only changes the layout (shapes and spacing), so you can enable both.

### Available preferences

<table>
  <tr>
    <th>Preference</th>
    <th>Description</th>
  </tr>
  <tr>
    <td><code>userChrome.ui-chrome-refresh</code></td>
    <td>Enable the new Chrome design named "Chrome Refresh".<img src="docs/assets/preview-chrome-refresh.png" alt="preview-chrome-refresh" /></td>
  </tr>
  <tr>
    <td><code>userChrome.theme-chrome-refresh</code></td>
    <td>Enable a new color scheme like in "Chrome Refresh".</td>
  </tr>
  <tr>
    <td><code>userChrome.theme-material</code></td>
    <td>Enable Material colour schemes. The blue palette is bundled, so this works on its own; red, yellow, green or your own palette need one more step. <a href="#material-theme">Read more</a>.</td>
  </tr>
  <tr>
    <td><code>userChrome.theme-default</code></td>
    <td>Enable the default color scheme. This can be useful if you want to use it with <a href="https://addons.mozilla.org/firefox/addon/adaptive-tab-bar-colour/">Adaptive Tab Bar Color</a> or native Firefox themes. Firefox's own pages (new tab, settings) keep Firefox's colours too.</td>
  </tr>
  <tr>
    <td><code>userChrome.ui-compact-url-bar</code></td>
    <td>Make the URL bar more compact by reducing its height.</td>
  </tr>
  <tr>
    <td><code>userChrome.ui-context-menu-icons</code></td>
    <td>Display icons beside right-click menu commands, such as Copy, Paste, Pin Tab and Mute Tab. Independent of <code>userChrome.ui-no-menu-icons</code>.</td>
  </tr>
  <tr>
    <td><code>userChrome.ui-no-menu-icons</code></td>
    <td>Hide the theme's icons in the main menu and its panels (New Tab, Downloads, Settings and so on). Firefox's own icons can still appear, and context menu icons from <code>userChrome.ui-context-menu-icons</code> are not affected.</td>
  </tr>
  <tr>
    <td><code>userChrome.ui-force-animation</code></td>
    <td>Keep the theme's animations, including the tab loading spinner, even when your OS asks for reduced motion or <code>userChrome.ui-no-animation</code> is on. <em>(Not required if you do not disable animation)</em></td>
  </tr>
  <tr>
    <td><code>userChrome.ui-no-animation</code></td>
    <td>Disable the theme's animations, including the tab loading spinner (the OS "reduce motion" setting does this too)</td>
  </tr>
  <tr>
    <td><code>userChrome.ui-system-font</code></td>
    <td>(Windows only) Use the default system font instead of Roboto.</td>
  </tr>
  <tr>
    <td><code>userChrome.ui-force-old-icons</code></td>
    <td>Use the theme's older icon set, with or without <code>userChrome.ui-chrome-refresh</code>.</td>
  </tr>
  <tr>
    <td><code>userChrome.ui-no-ripple</code></td>
    <td>Disable ripple effect from buttons</td>
  </tr>
  <tr>
    <td><code>userChrome.ui-no-nova-border</code></td>
    <td>Remove the borders and rounded corners the Firefox "Nova" redesign draws around the web content and sidebar, so they sit flush. The separator under the toolbars and the dividers between split-view panels stay. Only acts while <code>browser.nova.enabled</code> is on, the default in every channel since Firefox 157.</td>
  </tr>
  <tr>
    <td><code>userChrome.ui-white-toolbox</code></td>
    <td>Changes the whole toolbox to be white instead of the default light-grey tint, so the tab strip and the framing around the toolbars match the white URL-bar and bookmarks rows for an all-white top chrome. The tab strip loses its grey, so unselected tabs rely on the active tab and separators for distinction. Uses <code>--md-background-color-100</code>, so it follows the dark palette in dark mode. No effect with <code>userChrome.theme-default</code>. <code>false</code> by default.</td>
  </tr>
  <tr>
    <td><code>userChrome.ui-findbar-top-right</code></td>
    <td>Move the find-in-page bar (<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>F</kbd>) to the top-right corner of the content area, matching its pre-"Nova" floating position, instead of the default bottom dock. Works whether or not <code>browser.nova.enabled</code> is set.</td>
  </tr>
  <tr>
    <td><code>userChrome.ui-findbar-hide-checkboxes</code></td>
    <td>With <code>userChrome.ui-findbar-top-right</code> enabled, hide the find bar's four toggle checkboxes (Match Case, Match Diacritics, Whole Words, Highlight All) for a more compact bar at every window width. Below about 1100px wide the theme hides them anyway so the search box fits, and their settings still apply while hidden. Shown by default.</td>
  </tr>
  <tr>
    <td><code>userChrome.ui-no-not-secure-warning</code></td>
    <td>Hide the leading "Not Secure" chip shown on insecure (HTTP) pages, for a minimal, Chrome-like address bar. The secure (lock) indicator and breached-connection warnings are always kept. <code>false</code> by default.</td>
  </tr>
  <tr>
    <td><code>userChrome.ui-no-urlbar-history-badge</code></td>
    <td>Hide the small clock badge Firefox draws over the site icon of history suggestions in the address bar dropdown, so the icon shows in full. Bookmark and open-tab badges are kept. <code>false</code> by default.</td>
  </tr>
  <tr>
    <td><code>userChrome.ui-no-tab-audio-background</code></td>
    <td>Drop the circle (fill, border and shadow) behind the audio button on pinned tabs, leaving a plain speaker icon. The hover background is kept. <code>false</code> by default.</td>
  </tr>
  <tr>
    <td><code>userChrome.ui-no-pinned-tab-mute-click</code></td>
    <td>Clicking the audio button on a pinned tab selects the tab instead of muting it. Mute from the tab's context menu or with <kbd>Ctrl</kbd>+<kbd>M</kbd> instead. Regular tabs keep their clickable audio button. <code>false</code> by default.</td>
  </tr>
  <tr>
    <td><code>userChrome.ui-no-tab-title-changed-dot</code></td>
    <td>Hide the dot under an unselected pinned tab when its title changes, for example when a chat or mail tab gets new messages. The dot shown when a tab is waiting on a dialog is kept. <code>false</code> by default.</td>
  </tr>
  <tr>
    <td><code>userChrome.ui-chromium-tab-hover</code></td>
    <td>Use Chromium's tab hover timing: the hover colour comes in over 100ms and fades back out over 300ms, instead of the theme's quick 83ms both ways. Follows the reduce-motion settings like the theme's other animations. <code>false</code> by default.</td>
  </tr>
  <tr>
    <td><code>userChrome.ui-no-inactive-titlebar</code></td>
    <td>Keep the titlebar and tab strip in their active colours when the window loses focus, instead of turning grey. Useful when each profile has its own theme colour. <code>false</code> by default.</td>
  </tr>
  <tr>
    <td><code>userChrome.ui-tab-counter</code></td>
    <td>Show how many tabs are open on the "List all tabs" button, as a number in a rounded outline ("99+" past 99), in place of its icon. Counts the tabs in the horizontal tab strip. <code>false</code> by default.</td>
  </tr>
  <tr>
    <td><code>userChrome.ui-themed-pages</code></td>
    <td>Colour Firefox's own pages (Settings, Add-ons, about:config and the rest) with the theme's palette: page and card backgrounds and text follow the toolbar colours, so a preset from <code>custom.css</code> such as Dracula or GitHub reaches them too. The new tab page follows the palette already. No effect with <code>userChrome.theme-default</code>. <code>false</code> by default.</td>
  </tr>
  <tr>
    <td><code>userChrome.ui-white-urlbar-results</code></td>
    <td>Changes the open/focused URL bar and its search-results dropdown to white, like Chrome's omnibox, instead of the material grey tint. Uses <code>--md-background-color-100</code>, so it follows the dark palette in dark mode. No effect with <code>userChrome.theme-default</code>. <code>false</code> by default.</td>
  </tr>
</table>

### Setting preferences with user.js

Instead of creating each preference by hand, you can put them in a `user.js` file in your profile directory, next to the `chrome` folder. The repository's [user.js](user.js) lists them all. For example:

```javascript
// Compact floating find bar and a plain speaker icon on pinned tabs.
user_pref("userChrome.ui-findbar-top-right", true);
user_pref("userChrome.ui-findbar-hide-checkboxes", true);
user_pref("userChrome.ui-no-tab-audio-background", true);
```

Firefox reapplies `user.js` at every startup, so if you later change one of these in `about:config`, update or remove its line in `user.js` too.

## Custom CSS rules

You can also add your own user CSS rules by using the `custom.css` file. Additionally, if you want to change some colors, you can override the default variable values with your own.

Follow these steps:

1. **Find and rename** the `custom_example.css` file in the root folder to `custom.css`.
2. **Open** `custom.css` in a text editor.
3. **Find** the desired variable.
4. **Add your values**. For example, set the accent colour to red:

```css
@-moz-document url-prefix("chrome:"), regexp("about:(?!blank|srcdoc|devtools).*") {
  :root {
    --md-accent-color: #ea4335 !important;
  }
}
```

5. Save the file and restart Firefox to apply changes.

> [!NOTE]  
> Using this `custom.css` file can separate your changes from the source project. You can easily back up your file and not worry about overwriting your changes when updating or reinstalling the main files.

> [!TIP]
> `custom.css` is imported by both `userChrome.css` and `userContent.css`, so an unscoped rule also reaches every web page you visit. That's why the example above is wrapped in the same `@-moz-document` scope `chrome/theme-material-blue.css` uses.
>
> The two halves cover different things:
>
> - `url-prefix("chrome:")` is the browser window itself (tabs, toolbars, the address bar, menus, the find bar) and other Firefox windows such as the Library.
> - `regexp("about:...")` is Firefox's own pages (the new tab page, settings, `about:downloads` and so on), but not `about:blank`, embedded `about:srcdoc` frames or the developer tools.
>
> A rule that only touches the browser UI (the tab strip, for example) only needs `url-prefix("chrome:")`. Variable overrides and anything that also appears on an `about:` page (the downloads list is in both the downloads panel and `about:downloads`) need both. If you're not sure, just use both, so the rules never reach ordinary websites.
>
> ```css
> @-moz-document url-prefix("chrome:"), regexp("about:(?!blank|srcdoc|devtools).*") {
>   /* Library window (Bookmarks/History): smaller text so more rows fit */
>   window#places {
>     font-size: 10pt !important;
>   }
>
>   /* Downloads panel and about:downloads */
>   #downloadsListBox {
>     font-size: 10pt !important;
>   }
>
>   /* Find bar search box */
>   .findbar-textbox {
>     font-size: 12pt !important;
>   }
> }
> ```

### Available variables

<table>
  <tr>
    <th>Variable name</th>
    <th>Description</th>
  </tr>
  <tr>
    <td><code>--md-accent-color</code></td>
    <td>accent color</td>
  </tr>
  <tr>
    <td><code>--md-background-color-0</code></td>
    <td>dark tones</td>
  </tr>
  <tr>
    <td><code>--md-background-color-50</code></td>
    <td>middle tones</td>
  </tr>
  <tr>
    <td><code>--md-background-color-100</code></td>
    <td>light tones</td>
  </tr>
  <tr>
    <td><code>--md-text-primary</code></td>
    <td>main text color</td>
  </tr>
  <tr>
    <td><code>--md-text-secondary</code></td>
    <td>secondary text color</td>
  </tr>
  <tr>
    <td><code>--md-text-on-accent</code></td>
    <td>text on primary button</td>
  </tr>
  <tr>
    <td><code>--md-menu-background-color</code></td>
    <td>menu background color</td>
  </tr>
  <tr>
    <td><code>--md-menu-background-color-hover</code></td>
    <td>menu items background color on mouse over</td>
  </tr>
  <tr>
    <td><code>--md-menu-border-color</code></td>
    <td>controls border color</td>
  </tr>
  <tr>
    <td><code>--md-icon-color-primary</code></td>
    <td>navigation bar icons color</td>
  </tr>
  <tr>
    <td><code>--md-icon-color-secondary</code></td>
    <td>URL bar icons color</td>
  </tr>
  <tr>
    <td><code>--md-content-separator-color</code></td>
    <td>separator line between browser and content area</td>
  </tr>
  <tr>
    <td><code>--md-selection-text-color</code></td>
    <td>text selection color</td>
  </tr>
  <tr>
    <td><code>--md-selection-background-color</code></td>
    <td>selection background color</td>
  </tr>
</table>

> [!TIP]
> You can find more variables in the [variables/\_colors.scss](src/variables/_colors.scss) file. To use these variables, simply add the `--md-` prefix. For example, `"accent-color": #a8c7fa,` becomes `--md-accent-color: #a8c7fa;`.

### Custom css use cases

Here are some examples of how you can use the `custom.css` file:

- **Replacing** the font with your own. **Change** `"YourFontName"` to the name of your font:

  ```css
  @-moz-document url-prefix("chrome:"), regexp("about:(?!blank|srcdoc|devtools).*") {
    :root,
    html,
    body {
      --md-font-family: "YourFontName", sans-serif !important;
    }
  }
  ```

- **Removing** the separator line between the browser and content:

  ```css
  @-moz-document url-prefix("chrome:") {
    :root {
      --md-content-separator-color: transparent !important;
    }
  }
  ```

### Custom css use cases for creating your own color themes

> [!TIP]
> You can use variables to completely recolour the theme. Here are some preset examples with code:

Each example only applies when its own preference is enabled. Copy the file's contents into `custom.css`, create the preference shown in the table, and leave the built-in `userChrome.theme-*` preferences off. The colours reach the toolbar and the new tab page. To colour Firefox's other pages (Settings, Add-ons and so on) as well, also turn on `userChrome.ui-themed-pages`.

<table>
  <tr>
    <th>Description</th>
    <th>Preview</th>
  </tr>
  <tr>
    <td>
      <h2>System accent colors</h2>
      Source code: <br><a href="examples/theme-system-accent.css">theme-system-accent.css</a><br>Preference: <code>userChrome.theme-system-accent</code>
    </td>
    <td><img src="docs/assets/preview-accent-1.png" alt=""/><img src="docs/assets/preview-accent-2.png" alt=""/><img src="docs/assets/preview-accent-3.png" alt=""/></td>
  </tr>
  <tr>
    <td>
      <h2>Github theme</h2>
      Source code: <br><a href="examples/theme-github.css">theme-github.css</a><br>Preference: <code>userChrome.theme-github</code>
    </td>
    <td><img src="docs/assets/preview-github.png" alt="preview-github" /></td>
  </tr>
  <tr>
    <td>
      <h2>Dracula theme</h2>
      Source code: <br><a href="examples/theme-dracula.css">theme-dracula.css</a><br>Preference: <code>userChrome.theme-dracula</code>
    </td>
    <td><img src="docs/assets/preview-dracula.png" alt="preview-dracula"/></td>
  </tr>

</table>

## Material Theme

Enabling `userChrome.theme-material` uses the bundled blue palette, with no download needed. The red, yellow and green examples below also need their own preference (for example `userChrome.theme-material-red`) alongside `userChrome.theme-material`; copy the file's contents into `custom.css` as with the other colour themes.

You can also use the [Material Theme Builder](https://material-foundation.github.io/material-theme-builder/) to create a colour theme from an image.

1. **Create** the `userChrome.theme-material` preference in the `about:config` page.
2. **Go to** the [Material Theme Builder](https://material-foundation.github.io/material-theme-builder/) website.
3. **Select** from the presented images, **upload** your own, or **use** the "Random color" button to **generate** a theme.
4. **Click** the "Pick your fonts" button in the bottom right corner.
5. **Skip** this step and **click** the "Export theme" button.
6. **Click** "Export" and **select** "Web (CSS)" from the dropdown menu.

   ![material-theme-tutorial](docs/assets/material-theme-tutorial.png)

This will download an archive of CSS files. You only need two files: `light.css` and `dark.css`. Open these in a text editor and copy the `--md-sys-color-*` declarations into your `custom.css` file, keeping `userChrome.theme-material` enabled:

```css
@-moz-document url-prefix("chrome:"), regexp("about:(?!blank|srcdoc|devtools).*") {
  :root {
    /* Paste the colour declarations from light.css here. */
  }

  @media (prefers-color-scheme: dark) {
    :root {
      /* Paste the colour declarations from dark.css here. */
    }
  }
}
```

`custom.css` loads after the bundled blue palette, so your declarations replace it.

Examples with previews
| Example | Extra preference | Preview |
| --- | --- | --- |
| [theme-material-blue.css](chrome/theme-material-blue.css) (bundled) | None | ![material-blue-preview](docs/assets/material-blue-preview.png) |
| [theme-material-red.css](examples/theme-material-red.css) | `userChrome.theme-material-red` | ![material-red-preview](docs/assets/material-red-preview.png) |
| [theme-material-yellow.css](examples/theme-material-yellow.css) | `userChrome.theme-material-yellow` | ![material-yellow-preview](docs/assets/material-yellow-preview.png) |
| [theme-material-green.css](examples/theme-material-green.css) | `userChrome.theme-material-green` | ![material-green-preview](docs/assets/material-green-preview.png) |

## 🔧 Build & Development (for developers)

### Prerequisites

- [Node.js](https://nodejs.org/en/download) and npm. The Node version is pinned in [mise.toml](mise.toml), and [mise](https://mise.jdx.dev/) can install and select it for you.

### Installation

1. Open Firefox profile directory in terminal.
2. Clone this repo with the following command:

```bash
git clone https://github.com/joshuataylor/material-fox-updated-fork.git chrome
cd chrome
npm install
npm run dev
```

Project structure

```plaintext
[Profile Folder]
└── chrome
    ├── chrome
    ├── src
    │   ├── user-chrome
    │   ├── user-content
    │   ├── user-chrome.scss
    │   └── user-content.scss
    ├── package-lock.json
    ├── package.json
    ├── userChrome.css
    └── userContent.css
```

3. Then you can modify the files in the `src` directory, all changes will be automatically build in the `[Profile Folder]/chrome/chrome` folder.

To subsequently start the development mode, just use the following command:

```bash
npm run dev
```

### Testing

Firefox only loads user styles at startup, so restart it after a build. With mise you can test in a separate profile instead of your everyday one:

```bash
mise run build
mise run firefox -- --channel stable
```

The launcher downloads the chosen Firefox channel if needed and keeps its profile under `tmp/profiles/`. Use `--channel beta` or `--channel nightly` for the other builds, and `--nova off` to check the theme with Nova disabled.

Other checks:

```bash
npm run lint
mise run firefox-download
mise run verify-theme
mise run screenshots -- --channels stable --schemes light,dark --only findbar
```

`verify-theme` checks the rendered browser on each channel, and screenshots go to `tmp/screenshots/`.

## Credits

- [MaterialFox UPDATED](https://github.com/edelvarden/material-fox-updated) by [edelvarden](https://github.com/edelvarden) (this project - [material-fox-updated-fork](https://github.com/joshuataylor/material-fox-updated-fork), is a continuation of their, and everyone else's, fantastic work). Thank you.
- [MaterialFox](https://github.com/muckSponge/MaterialFox) by [muckSponge](https://github.com/muckSponge)
- [edge-frfox](https://github.com/bmFtZQ/edge-frfox) by [bmFtZQ](https://github.com/bmFtZQ)
