# Development

Notes for working on Translate Hover. User-facing documentation lives in the
[root README](../README.md).

## Setup

```bash
npm install
npm run compile     # or: npm run watch
```

Open the repository in VS Code and press `F5` to launch an Extension
Development Host with the extension loaded.

## Packaging

```bash
npx @vscode/vsce package
code --install-extension translate-hover-<version>.vsix --force
```

**Bump `version` in `package.json` before packaging.** `code --install-extension`
refuses a version that is already installed — it prints "already installed" and
exits without replacing anything, which looks exactly like a code change that
did not take effect. `--force` covers the same case; doing both is the reliable
combination. Reload the window afterwards, because the extension host keeps the
old code otherwise.

## Layout

| File | Responsibility |
|---|---|
| `extension.ts` | Activation, commands, decoration, status bar, hover provider, popup markdown |
| `translate.ts` | HTTP against the three engines, caching, TTS and web URLs |
| `languages.ts` | Language code to display name table |

## How a translation flows

1. `provideHover` (or a command) reads the selection.
2. `prepare()` strips comment markers, normalises whitespace, and applies
   `preserveLineBreaks` and `maxLength`.
3. `translate()` splits the text on newlines and translates each non-empty line
   as its own segment, then reassembles them against the original line indices
   so blank lines survive.
4. `buildPopup()` renders the result as Markdown.

## Constraints worth knowing before changing things

**The free endpoints are GET, so the URL is the real limit.** Both reject past
roughly 16 KB — measured against the live hosts, 15,092 bytes returns 200 and
16,457 returns 400, then 413 further up. `guardUrlLength()` fails early with a
message a user can act on. This is why `maxLength` defaults to 1500: a CJK
character costs 9 bytes URL-encoded.

**The `client` parameter matters more than the host.** `client=gtx`, the value
most examples online use, is answered with a 429 anti-abuse page on *both*
hosts. `client=dict-chrome-ex` (the Chrome extension) and `client=at` (the
Android app) still work. If translation starts failing everywhere, check this
first.

**Response shapes differ by endpoint and by `sl`.** `translate_a/t` returns one
entry per `q`, either `"text"` (explicit `sl`) or `["text", "detected"]`
(`sl=auto`). The fallback `translate_a/single` takes a single `q`, so segments
go over joined by newlines and are split back apart from the response.

**Hover Markdown is sanitized.** Allowed attributes are `href`, `target`, `src`,
`alt`, `title`, `for`, `name`, `role`, `tabindex`, `x-dispatch`, `required`,
`checked`, `placeholder`, `type`, `start`, `width`, `height`, `align` — no
`style`, no `class`, no `data-*`. There is no way to set a background or border.
`---` is the only element VS Code stretches to the popup edges, which is why the
layout uses rules as section dividers.

A single newline collapses to a space in Markdown, and whether a two-space hard
break survives depends on how the hover configures `marked`. `<br>` with
`supportHtml = true` does not, so the popup uses that. Emphasis is applied per
line because it cannot span a break.

**Decorations do not receive clicks.** The 🌐 marker cannot be a button. Any
interaction has to come from the hover popup's command links.

## The API key

Stored in `context.secrets` (the OS keychain) under `translateHover.apiKey`, not
in settings. The old plaintext setting is still read once by `migrateApiKey()`,
which copies it into the keychain and then deletes it from every configuration
scope it was written to.

The key travels in the `X-Goog-Api-Key` header rather than the `?key=` query
parameter that the API also accepts, so it stays out of the URL — a corporate
proxy doing TLS inspection logs full URLs.

When a key is present, `translate()` calls the official API only. It does **not**
fall back to the unofficial endpoints on failure, so a broken key surfaces as an
error rather than as silent use of an endpoint the organisation did not agree to.

## Testing against the live endpoints

There is no test suite. The engines can be exercised directly against the
compiled output:

```bash
npm run compile
node -e "
const { translate } = require('./out/translate.js');
translate({ text: 'これは仕様です。\n完了する。', from: 'auto', to: 'vi' })
  .then(r => console.log(r.detectedSource, JSON.stringify(r.text)));
"
```

Check line counts in and out when changing anything in the segment path — a
mismatch there is how translations end up mapped onto the wrong lines.
