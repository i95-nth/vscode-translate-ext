# Translate Hover

Select any text in the editor, hover it, and read the Google Translate result in
a popup without leaving VS Code — the same gesture as the Google Translate
extension in Chrome.

## Getting started

Nothing to configure. Select a piece of text and a 🌐 marker appears after it.
Hover that marker and click **Translate** — the popup opens with the result.

While the request is out the popup opens straight away with a spinner, the
marker turns into ⏳, and a `Translating…` indicator appears in the status bar.
The spinner always stays up for a moment even when the answer arrives sooner,
so it reads as progress rather than as a flicker. Text already translated in
this session skips all of that and opens complete.

The marker only follows selections you made with the mouse or the keyboard.
Stepping through Find matches re-selects on every hit, and marking each one
would be noise — those selections are left alone. `Cmd+Alt+T` still translates
whatever is selected, however it got selected.

Translation is deliberate by design: hovering the selection never sends
anything on its own, so a stray mouse movement cannot spend quota. The marker
tells you how much it will cost before you commit, and text already translated
in this session skips the confirmation because it costs nothing.

| Action | Result |
|---|---|
| Select text, hover the 🌐 marker, click **Translate** | The translation popup opens |
| `Cmd+Alt+T` (macOS) / `Ctrl+Alt+T` | Open the popup immediately, no hovering |
| `Cmd+Alt+Shift+T` / `Ctrl+Alt+Shift+T` | Translate and **replace** the selection in place |
| Click the status bar item (`🌐 auto → vi`) | Change the target language |
| Right-click the selection | Translate commands in the context menu |

## Inside the popup

The popup is laid out as three sections divided by rules: the language pair on
top, the original text, then the translation.

Each block carries its own small toolbar:

| Button | Does |
|---|---|
| 🔊 | Play the text through Google's text-to-speech in your browser |
| ↗ | Open the original on translate.google.com |
| 📋 Copy | Copy the translation to the clipboard |
| ⇄ Replace | Replace the selected text with the translation |

Line breaks in the source are preserved: each line is translated on its own and
rendered on its own line, so a multi-line comment keeps its shape.

## Changing languages without opening Settings

- Click the **source** or **target** language name at the top of the popup to
  open a picker. The popup re-translates and reopens by itself.
- The shortcut row under the translation (`vi · en · ja · zh-CN`) switches the
  target language in one click. Edit the list with `translateHover.quickLanguages`.
- The ⇄ button swaps source and target.
- Languages you picked recently move to the top of the picker next time.
- Pick **Detect language** in the source picker to go back to `auto`. While on
  auto, the popup shows the language Google detected, marked `(auto)`.

## Commands

All of these are available from the Command Palette under `Translate:`.

| Command | Purpose |
|---|---|
| Translate Selection | Open the popup for the current selection |
| Replace Selection With Translation | Overwrite the selection with its translation |
| Change Target Language / Change Source Language | Open the language picker |
| Swap Source / Target Language | Reverse the direction |
| Copy Last Translation | Copy the most recent result |
| Speak Text | Play the last result as audio |
| Open In Google Translate | Open the text on translate.google.com |
| Set Google Cloud API Key | Store an official API key in the OS keychain |
| Clear Google Cloud API Key | Remove the stored key and return to the free endpoint |
| Clear Cache | Drop the in-memory translation cache |
| Extension Options | Jump to these settings |

## Settings

Everything lives under `translateHover.*`.

| Setting | Default | What it does |
|---|---|---|
| `targetLanguage` | `vi` | Language to translate into |
| `sourceLanguage` | `auto` | Language to translate from, or `auto` to detect |
| `quickLanguages` | `vi, en, ja, zh-CN` | Codes shown as one-click shortcuts in the popup. Set to `[]` to hide the row |
| `showIconOnSelect` | `true` | Show the 🌐 marker after a selection |
| `manualSelectionOnly` | `true` | Only mark selections you made by hand, not ones a command produced |
| `confirmBeforeTranslate` | `true` | Require a click on the marker before sending a selection. Turn off to translate on hover |
| `autoShowPopup` | `false` | Open the popup as soon as text is selected, without hovering |
| `autoShowDelay` | `350` | Debounce in milliseconds before reacting to a selection change |
| `hoverOnWord` | `false` | Translate the word under the cursor even with nothing selected |
| `preserveLineBreaks` | `all` | `all` keeps every line, `paragraph` folds hard-wrapped lines and keeps blank lines, `off` flattens everything onto one line |
| `renderMarkdown` | `true` | Render Markdown tables in the popup as tables |
| `stripCommentMarkers` | `true` | Drop `//`, `/* */`, `#`, `<!-- -->` and indentation before translating |
| `maxLength` | `1500` | Longest selection sent to the engine |
| `showStatusBar` | `true` | Show the current language pair in the status bar |
| `proxy` | empty | Use a different host instead of `clients5.google.com` |

### Why `maxLength` is 1500

The free endpoints carry the text inside the URL, and Google rejects anything
past roughly 16 KB. A CJK character costs 9 bytes once URL-encoded, so Japanese
text hits that ceiling at around 1,800 characters — well before the character
count looks large. Selections beyond the limit report a clear message rather
than a bare HTTP error. Raising this only makes sense with an API key set,
because the official API sends the text in the request body instead.

## Translation engines

**Without a key** the extension calls `clients5.google.com/translate_a/t`, the
endpoint the Google Translate Chrome extension uses, and falls back to
`translate.googleapis.com` if that fails. These are free and need no setup, but
they are **unofficial**: they are rate limited, undocumented, and Google can
change them at any time.

**With a key** every request goes to the official Cloud Translation API v2
instead, and the unofficial endpoints are never called. Run **Translate: Set
Google Cloud API Key** to store one — it is kept in the OS keychain, not in
`settings.json`, so Settings Sync never carries it off the machine and it cannot
be committed to a repository by accident.

Google bills the official API by **source characters sent**, with the first
500,000 characters each month free. For reference, a typical paragraph-sized
selection is 100–200 characters.

### Translating tables

A selected Markdown table comes back as a table rather than as flat lines. This
works because each line is translated as its own request, so the engine never
sees the table as a whole and cannot restructure it — the divider row and every
`|` come back in place.

Detection happens per block, not per selection, so a document holding prose and
a table renders both correctly in one popup. A run of lines is treated as a
table only when Markdown itself would accept it: consecutive rows wrapped in
`|`, with a `| --- |` divider among them. Everything else keeps its own line
break exactly as before, which matters because Markdown reads a single newline
as a space — prose rendered as Markdown would lose the line breaks the
translation just preserved.

Set `translateHover.renderMarkdown` to `false` to switch tables off as well.

Note that `stripCommentMarkers` removes a leading `#` before the text is sent,
so Markdown headings arrive as plain text. Turn that setting off too if you are
translating documents rather than code.

Links and raw HTML in the selection are never rendered. The popup is a trusted
Markdown surface where a `command:` link would run a VS Code command when
clicked, and text out of an arbitrary file must not be able to build one.

## Using an API key

### Adding a key

1. In the [Google Cloud console](https://console.cloud.google.com/), pick a
   project and enable **Cloud Translation API**. The API requires billing to be
   enabled on the project, including for the free monthly characters.
2. Go to **APIs & Services → Credentials → Create credentials → API key**.
3. Restrict the new key to the Cloud Translation API. An unrestricted key works
   against every API enabled on the project, so anyone who obtains it can spend
   far more than translation.
4. In VS Code, run **Translate: Set Google Cloud API Key** from the Command
   Palette and paste the key. The input is masked.

The status bar keeps showing the language pair; there is no separate indicator
for which engine is active. To confirm the key took effect, translate something
and watch for errors — a bad key fails loudly rather than falling back.

### Where the key is stored

In the operating system keychain, through the VS Code secret storage API — not
in `settings.json`. That means Settings Sync never carries it to another
machine, and it cannot end up in a committed `.vscode/settings.json`.

The old `translateHover.apiKey` setting is deprecated. If a key is still there,
it is moved into the keychain the next time the extension starts and then
deleted from every settings scope it was written to. You will see a notification
when that happens.

### Removing a key

Run **Translate: Clear Google Cloud API Key**. Translation returns to the free
unofficial endpoints immediately, and the cache is cleared so nothing is served
from the previous engine.

### Capping what a key can spend

The per-day character quota defaults to **unlimited**, so nothing stops usage
once the free 500,000 characters are gone. Set a cap explicitly:

**APIs & Services → Cloud Translation API → Quotas →** *Characters sent to
general model per project per day*.

A daily limit of **16,000** keeps a project under 500,000 characters even in a
31-day month — roughly 110 paragraph-sized translations per day, shared across
everyone using that key.

Two things to plan around: the quota resets at midnight **Pacific time**, and a
new quota can take **up to 24 hours** to take effect. Set it before handing the
key out, not when you need it.

Once the cap is reached the API answers `403 Daily Limit Exceeded`, which the
extension shows in the popup. It does **not** fall back to the unofficial
endpoints — with a key configured, those are never called.

If several people share one key, this quota is the only thing that sees the
combined total. Nothing on an individual machine can.

## Known limits

VS Code does not let an extension paint an arbitrary HTML popup at the cursor
the way a Chrome extension can. This popup is the editor's native Hover, which
renders Markdown and strips `style`, `class` and `data-*` attributes. That
rules out custom backgrounds and borders, so the layout uses rules and toolbars
instead.

Two consequences worth knowing:

- The 🔊 button opens audio in an external browser rather than playing it inside
  the editor, and Google's text-to-speech endpoint accepts about 200 characters
  per request.
- The 🌐 marker is a decoration, and decorations do not receive click events.
  Hover it to open its own small popup, and click the link inside that.

The translation cache holds 500 entries in memory and is not written to disk, so
it starts empty after a window reload.
