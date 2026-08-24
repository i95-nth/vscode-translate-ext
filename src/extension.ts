import * as vscode from 'vscode';
import { LANGUAGES, Language, languageName } from './languages';
import { clearCache, isCached, translate, ttsUrl, webUrl } from './translate';

const SECTION = 'translateHover';

let iconDecoration: vscode.TextEditorDecorationType;
let statusBar: vscode.StatusBarItem;
let selectionTimer: NodeJS.Timeout | undefined;
let lastResult: { source: string; translated: string; from: string; to: string } | undefined;
let output: vscode.OutputChannel;
let state: vscode.Memento | undefined;
let secrets: vscode.SecretStorage | undefined;

/**
 * The prepared text the user has explicitly asked to translate. Hovering a
 * selection is easy to do by accident and every miss is a billed request, so
 * nothing reaches the network until the marker's link is clicked — this holds
 * what that click approved.
 */
let armed: string | undefined;

/**
 * The key lives in the OS keychain, not in settings.json: a plain setting is
 * carried off the machine by Settings Sync, and a workspace-level one lands in
 * .vscode/settings.json where it gets committed. The old setting is still read
 * once, so an existing config keeps working — see migrateApiKey.
 */
const API_KEY_SECRET = `${SECTION}.apiKey`;

export function activate(context: vscode.ExtensionContext): void {
    output = vscode.window.createOutputChannel('Translate Hover');
    state = context.globalState;
    secrets = context.secrets;
    void migrateApiKey();

    iconDecoration = vscode.window.createTextEditorDecorationType({
        after: {
            contentText: ' 🌐',
            margin: '0 0 0 0.25em',
            fontStyle: 'normal'
        },
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    });

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = `${SECTION}.pickTargetLanguage`;
    statusBar.tooltip = 'Translate Hover: click to change target language';
    updateStatusBar();

    context.subscriptions.push(
        output,
        iconDecoration,
        statusBar,
        vscode.languages.registerHoverProvider({ scheme: '*', language: '*' }, { provideHover }),
        vscode.window.onDidChangeTextEditorSelection(onSelectionChange),
        vscode.window.onDidChangeActiveTextEditor(() => scheduleDecoration()),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration(SECTION)) {
                updateStatusBar();
                scheduleDecoration();
            }
        }),
        vscode.commands.registerCommand(`${SECTION}.translateSelection`, translateSelectionCommand),
        vscode.commands.registerCommand(`${SECTION}.pickTargetLanguage`, (code?: string) => pickLanguage('targetLanguage', code)),
        vscode.commands.registerCommand(`${SECTION}.pickSourceLanguage`, (code?: string) => pickLanguage('sourceLanguage', code)),
        vscode.commands.registerCommand(`${SECTION}.swapLanguages`, swapLanguages),
        vscode.commands.registerCommand(`${SECTION}.copyLastResult`, copyLastResult),
        vscode.commands.registerCommand(`${SECTION}.replaceSelection`, replaceSelectionCommand),
        vscode.commands.registerCommand(`${SECTION}.speak`, speak),
        vscode.commands.registerCommand(`${SECTION}.openInBrowser`, openInBrowser),
        vscode.commands.registerCommand(`${SECTION}.openSettings`, () =>
            vscode.commands.executeCommand('workbench.action.openSettings', SECTION)
        ),
        vscode.commands.registerCommand(`${SECTION}.setApiKey`, setApiKey),
        vscode.commands.registerCommand(`${SECTION}.clearApiKey`, clearApiKey),
        vscode.commands.registerCommand(`${SECTION}.clearCache`, () => {
            clearCache();
            vscode.window.showInformationMessage('Translate Hover: cache cleared.');
        })
    );

    scheduleDecoration();
}

export function deactivate(): void {
    if (selectionTimer) {
        clearTimeout(selectionTimer);
    }
}

/* --------------------------------------------------------------- api key */

async function getApiKey(): Promise<string | undefined> {
    return (await secrets?.get(API_KEY_SECRET)) || undefined;
}

/**
 * Moves a key left in settings.json into the keychain, once, then deletes the
 * plaintext copy from every scope it was written to.
 */
async function migrateApiKey(): Promise<void> {
    if (!secrets || (await secrets.get(API_KEY_SECRET))) {
        return;
    }

    const cfg = config();
    const found = cfg.inspect<string>('apiKey');
    const stale: [string | undefined, vscode.ConfigurationTarget][] = [
        [found?.globalValue, vscode.ConfigurationTarget.Global],
        [found?.workspaceValue, vscode.ConfigurationTarget.Workspace],
        [found?.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder]
    ];

    const key = stale.find(([value]) => !!value)?.[0];
    if (!key) {
        return;
    }

    await secrets.store(API_KEY_SECRET, key);
    for (const [value, target] of stale) {
        if (value) {
            await cfg.update('apiKey', undefined, target);
        }
    }

    output.appendLine('[apiKey] moved out of settings.json into the OS keychain');
    void vscode.window.showInformationMessage(
        'Translate Hover: your API key was moved from settings.json into the OS keychain. ' +
            'Use "Translate: Set Google Cloud API Key" to change it.'
    );
}

async function setApiKey(): Promise<void> {
    const value = await vscode.window.showInputBox({
        title: 'Google Cloud Translation API key',
        prompt: 'Stored in the OS keychain, never in settings.json. Leave empty to cancel.',
        password: true,
        ignoreFocusOut: true
    });
    if (!value) {
        return;
    }
    await secrets?.store(API_KEY_SECRET, value.trim());
    clearCache();
    vscode.window.showInformationMessage('Translate Hover: API key saved. The official API is now in use.');
}

async function clearApiKey(): Promise<void> {
    await secrets?.delete(API_KEY_SECRET);
    clearCache();
    vscode.window.showInformationMessage('Translate Hover: API key removed. Falling back to the free endpoint.');
}

/* ---------------------------------------------------------------- config */

function config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(SECTION);
}

function updateStatusBar(): void {
    const cfg = config();
    if (!cfg.get<boolean>('showStatusBar', true)) {
        statusBar.hide();
        return;
    }
    const from = cfg.get<string>('sourceLanguage', 'auto')!;
    const to = cfg.get<string>('targetLanguage', 'vi')!;
    statusBar.text = `$(globe) ${from} → ${to}`;
    statusBar.show();
}

/* ------------------------------------------------------------ decoration */

function onSelectionChange(e: vscode.TextEditorSelectionChangeEvent): void {
    scheduleDecoration(e.textEditor);
}

function scheduleDecoration(editor = vscode.window.activeTextEditor): void {
    if (selectionTimer) {
        clearTimeout(selectionTimer);
    }
    if (!editor) {
        return;
    }
    const delay = config().get<number>('autoShowDelay', 350)!;
    selectionTimer = setTimeout(() => renderDecoration(editor), Math.max(0, delay));
}

function renderDecoration(editor: vscode.TextEditor): void {
    if (editor !== vscode.window.activeTextEditor) {
        return;
    }
    const cfg = config();
    const selection = editor.selection;
    const text = selection.isEmpty ? '' : readSelection(editor);

    if (!cfg.get<boolean>('showIconOnSelect', true) || !text) {
        editor.setDecorations(iconDecoration, []);
        return;
    }

    const auto = cfg.get<boolean>('autoShowPopup', false);
    if (auto) {
        // Opting into an automatic popup is opting into the request behind it.
        armed = text;
    }

    // The icon is injected after the last selected character. Its own hover is
    // the gate, so it is only attached while the text still needs approving.
    const range = new vscode.Range(selection.end, selection.end);
    editor.setDecorations(iconDecoration, [
        needsApproval(text, cfg) ? { range, hoverMessage: gate(text, editor) } : { range }
    ]);

    if (auto) {
        void vscode.commands.executeCommand('editor.action.showHover');
    }
}

/** True while translating this text would cost a request the user has not asked for. */
function needsApproval(text: string, cfg: vscode.WorkspaceConfiguration): boolean {
    if (!cfg.get<boolean>('confirmBeforeTranslate', true) || armed === text) {
        return false;
    }
    // A cached answer costs nothing, so there is nothing to approve.
    return !isCached({
        text,
        from: cfg.get<string>('sourceLanguage', 'auto')!,
        to: cfg.get<string>('targetLanguage', 'vi')!
    });
}

interface Anchor {
    uri: string;
    range: [number, number, number, number];
}

/**
 * The popup shown on the marker before anything is sent. Clicking a link inside
 * a hover can drop the editor's selection, so the range travels with the
 * command rather than being read back off the editor when it runs.
 */
function gate(text: string, editor: vscode.TextEditor): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    const { start, end } = editor.selection;
    const anchor: Anchor = {
        uri: editor.document.uri.toString(),
        range: [start.line, start.character, end.line, end.character]
    };

    const count = text.length === 1 ? '1 character' : `${text.length} characters`;
    md.appendMarkdown(
        `[$(globe) Translate ${count}](command:${SECTION}.translateSelection?${encodeURIComponent(
            JSON.stringify([anchor])
        )} "Send this selection to the translation engine")`
    );
    return md;
}

/* ----------------------------------------------------------------- hover */

/** Collapses a range onto its end, where the 🌐 marker sits. */
function atMarker(range: vscode.Range): vscode.Range {
    return new vscode.Range(range.end, range.end);
}

async function provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
): Promise<vscode.Hover | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== document) {
        return undefined;
    }

    const cfg = config();
    let range: vscode.Range | undefined;

    const selection = editor.selections.find(s => !s.isEmpty && s.contains(position));
    if (selection) {
        range = new vscode.Range(selection.start, selection.end);
    } else if (cfg.get<boolean>('hoverOnWord', false)) {
        range = document.getWordRangeAtPosition(position);
    }

    if (!range) {
        return undefined;
    }

    const raw = document.getText(range);
    const text = prepare(raw, cfg);
    if (!text) {
        return undefined;
    }

    // Hovering a word is an explicit opt-in of its own; a selection has to be
    // approved through the marker first, and the marker carries its own hover.
    if (selection && needsApproval(text, cfg)) {
        return undefined;
    }

    const from = cfg.get<string>('sourceLanguage', 'auto')!;
    const to = cfg.get<string>('targetLanguage', 'vi')!;

    output.appendLine(`[hover] ${from} -> ${to} :: ${text.slice(0, 60)}`);

    try {
        const result = await translate({
            text,
            from,
            to,
            apiKey: await getApiKey(),
            host: cfg.get<string>('proxy') || undefined
        });
        if (token.isCancellationRequested) {
            return undefined;
        }
        lastResult = { source: text, translated: result.text, from: result.detectedSource, to };
        // VS Code places the popup at the start of the hover's range, which for
        // a whole selection means far above the marker the user just clicked.
        return new vscode.Hover(buildPopup(text, result.text, result.detectedSource, to), atMarker(range));
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output.appendLine(`[${new Date().toISOString()}] ${message}`);
        const md = new vscode.MarkdownString(`$(error) **Translate failed** — ${escapeMd(message)}`);
        md.supportThemeIcons = true;
        return new vscode.Hover(md, atMarker(range));
    }
}

/**
 * Builds the popup body, mirroring the Google Translate bubble layout.
 *
 * A hover sanitizes away `style`, `class` and `data-*`, so there is no way to
 * paint a real card: `---` is the only element VS Code stretches to the popup
 * edges (`.monaco-hover hr` has a negative horizontal margin), which makes it
 * the one primitive that reads as a section boundary. The layout leans on that
 * — a toolbar row of its own above each block, never icons inline with prose.
 */
function buildPopup(source: string, translated: string, from: string, to: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;
    md.supportHtml = true;

    const link = (command: string, args: unknown[]) =>
        `command:${SECTION}.${command}?${encodeURIComponent(JSON.stringify(args))}`;

    // Both language names are links that open their picker right from the popup.
    const configuredSource = config().get<string>('sourceLanguage', 'auto')!;
    const sourceLabel = configuredSource === 'auto' ? `${languageName(from)} (auto)` : languageName(from);

    md.appendMarkdown(
        `$(globe) [${escapeMd(sourceLabel)}](${link('pickSourceLanguage', [])} "Change source language") ` +
            `$(arrow-right) [**${escapeMd(languageName(to))}**](${link('pickTargetLanguage', [])} "Change target language") ` +
            `&nbsp; [$(arrow-swap)](${link('swapLanguages', [])} "Swap languages") ` +
            `[$(gear)](${link('openSettings', [])} "Extension options")\n\n`
    );

    md.appendMarkdown('---\n\n');

    md.appendMarkdown(
        section(
            [
                `[$(unmute)](${link('speak', [source, from])} "Listen to the original")`,
                `[$(link-external)](${link('openInBrowser', [source, from, to])} "Open in Google Translate")`
            ],
            source,
            false
        )
    );

    md.appendMarkdown('---\n\n');

    md.appendMarkdown(
        section(
            [
                `[$(unmute)](${link('speak', [translated, to])} "Listen to the translation")`,
                `[$(copy) Copy](${link('copyLastResult', [])} "Copy translation")`,
                `[$(replace-all) Replace](${link('replaceSelection', [])} "Replace selection with translation")`
            ],
            translated,
            true
        )
    );

    const quick = quickLanguageRow(to, link);
    if (quick) {
        md.appendMarkdown(`---\n\n${quick}`);
    }

    return md;
}

/**
 * One block of the bubble: its own toolbar row, then the text underneath.
 * Markdown turns a single newline into a mere space, and whether a two-space
 * hard break survives depends on how the hover renderer configures marked — an
 * explicit `<br>` does not. Emphasis is applied per line because it cannot span
 * a break.
 */
function section(actions: string[], text: string, bold: boolean): string {
    const toolbar = actions.join('&nbsp;&nbsp;&nbsp;');
    const body = text
        .split('\n')
        .map(line => (line === '' ? '&nbsp;' : bold ? `**${escapeMd(line)}**` : escapeMd(line)))
        .join('<br>');
    return `${toolbar}<br>${body}\n\n`;
}

/** One-click shortcuts to the languages the user switches between most. */
function quickLanguageRow(current: string, link: (c: string, a: unknown[]) => string): string {
    const codes = config().get<string[]>('quickLanguages', [])!;
    if (codes.length === 0) {
        return '';
    }

    const cells = codes.map(code =>
        code === current
            ? `**${escapeMd(code)}**`
            : `[${escapeMd(code)}](${link('pickTargetLanguage', [code])} "Translate to ${languageName(code)}")`
    );
    return `$(arrow-right) ${cells.join(' &nbsp;·&nbsp; ')}`;
}

/* -------------------------------------------------------------- commands */

async function translateSelectionCommand(anchor?: Anchor): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }

    // Put back what the click dropped. Active goes to the end so the cursor —
    // and therefore the popup — lands on the marker rather than above the text.
    if (anchor && editor.document.uri.toString() === anchor.uri) {
        const [startLine, startChar, endLine, endChar] = anchor.range;
        editor.selection = new vscode.Selection(startLine, startChar, endLine, endChar);
    }

    if (editor.selection.isEmpty) {
        vscode.window.showInformationMessage('Translate Hover: select some text first.');
        return;
    }

    // Reaching this command at all is the approval, whether it came from the
    // marker's link or the keybinding.
    armed = readSelection(editor);

    // Not just showHover: the gate answered this position with "no hover", and
    // VS Code caches that per position, so re-showing here replays the refusal.
    // reopenPopup nudges the selection, which is what invalidates it.
    await reopenPopup();
}

async function replaceSelectionCommand(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
        vscode.window.showInformationMessage('Translate Hover: select some text first.');
        return;
    }

    const cfg = config();
    const selection = editor.selection;
    const text = prepare(editor.document.getText(selection), cfg);
    if (!text) {
        return;
    }

    armed = text;
    const apiKey = await getApiKey();

    try {
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: 'Translating…' },
            () =>
                translate({
                    text,
                    from: cfg.get<string>('sourceLanguage', 'auto')!,
                    to: cfg.get<string>('targetLanguage', 'vi')!,
                    apiKey,
                    host: cfg.get<string>('proxy') || undefined
                })
        );
        await editor.edit(builder => builder.replace(selection, result.text));
    } catch (err) {
        vscode.window.showErrorMessage(`Translate Hover: ${err instanceof Error ? err.message : String(err)}`);
    }
}

async function copyLastResult(): Promise<void> {
    if (!lastResult) {
        vscode.window.showInformationMessage('Translate Hover: nothing translated yet.');
        return;
    }
    await vscode.env.clipboard.writeText(lastResult.translated);
    vscode.window.setStatusBarMessage('$(check) Translation copied', 2000);
}

async function speak(text?: string, lang?: string): Promise<void> {
    const value = text ?? lastResult?.translated;
    if (!value) {
        return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(ttsUrl(value, lang ?? config().get<string>('targetLanguage', 'vi')!)));
}

async function openInBrowser(text?: string, from?: string, to?: string): Promise<void> {
    const cfg = config();
    const value = text ?? lastResult?.source;
    if (!value) {
        return;
    }
    const url = webUrl(
        value,
        from ?? cfg.get<string>('sourceLanguage', 'auto')!,
        to ?? cfg.get<string>('targetLanguage', 'vi')!
    );
    await vscode.env.openExternal(vscode.Uri.parse(url));
}

async function pickLanguage(key: 'targetLanguage' | 'sourceLanguage', code?: string): Promise<void> {
    const cfg = config();
    const current = cfg.get<string>(key)!;

    // A code passed straight from a popup shortcut skips the picker entirely.
    let chosen = typeof code === 'string' && code ? code : undefined;

    if (!chosen) {
        const recent = recentLanguages(key);
        const available = LANGUAGES.filter(l => key === 'sourceLanguage' || l.code !== 'auto');
        // Recently used first, so the two or three languages in daily rotation
        // are always one keystroke away.
        const ordered = [
            ...recent.map(c => available.find(l => l.code === c)).filter((l): l is Language => !!l),
            ...available.filter(l => !recent.includes(l.code))
        ];

        const picked = await vscode.window.showQuickPick(
            ordered.map(l => ({
                label: l.code === current ? `$(check) ${l.name}` : l.name,
                description: l.code,
                detail: recent.includes(l.code) && l.code !== current ? 'Recently used' : undefined
            })),
            {
                title: key === 'targetLanguage' ? 'Translate to…' : 'Translate from…',
                placeHolder: `Current: ${languageName(current)}`,
                matchOnDescription: true
            }
        );
        if (!picked) {
            return;
        }
        chosen = picked.description;
    }

    if (chosen !== current) {
        await cfg.update(key, chosen, vscode.ConfigurationTarget.Global);
        await rememberLanguage(key, chosen);
        updateStatusBar();
    }
    await reopenPopup();
}

/** Language codes the user picked recently, most recent first. */
function recentLanguages(key: string): string[] {
    return state?.get<string[]>(`recent.${key}`, []) ?? [];
}

async function rememberLanguage(key: string, code: string): Promise<void> {
    if (!state || code === 'auto') {
        return;
    }
    const next = [code, ...recentLanguages(key).filter(c => c !== code)].slice(0, 5);
    await state.update(`recent.${key}`, next);
}

/**
 * Clicking a link inside a hover dismisses it, so anything that changes the
 * translation has to put the popup back up afterwards.
 */
async function reopenPopup(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
        return;
    }

    // A pending debounce from the settings change would fire mid-reopen.
    if (selectionTimer) {
        clearTimeout(selectionTimer);
        selectionTimer = undefined;
    }

    await vscode.window.showTextDocument(editor.document, editor.viewColumn, false);

    // Fetch the new pair up front so the reopened popup paints the fresh
    // translation immediately instead of flashing a spinner: provideHover
    // then reads it straight out of the cache.
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Translating…' },
        () => prefetch(editor)
    );

    // Re-showing a hover at the position it was just dismissed at hands back
    // the result computed for the previous language pair. Dropping it and
    // moving the cursor off the spot and back invalidates that — the same
    // thing the user was doing by hand when reselecting the text.
    await vscode.commands.executeCommand('editor.action.hideHover');

    const selection = editor.selection;
    editor.selection = new vscode.Selection(selection.end, selection.end);
    await delay(0);
    editor.selection = new vscode.Selection(selection.start, selection.end);

    // The nudge queued two more debounced passes; drop them so they cannot
    // re-trigger the hover once it is already up.
    if (selectionTimer) {
        clearTimeout(selectionTimer);
        selectionTimer = undefined;
    }

    renderDecoration(editor);
    await vscode.commands.executeCommand('editor.action.showHover');
}

/** Warms the cache for the current selection and language pair. */
async function prefetch(editor: vscode.TextEditor): Promise<void> {
    const cfg = config();
    const text = prepare(editor.document.getText(editor.selection), cfg);
    if (!text) {
        return;
    }
    // Switching languages on an open popup is a request for the new pair.
    armed = text;
    try {
        await translate({
            text,
            from: cfg.get<string>('sourceLanguage', 'auto')!,
            to: cfg.get<string>('targetLanguage', 'vi')!,
            apiKey: await getApiKey(),
            host: cfg.get<string>('proxy') || undefined
        });
    } catch {
        // provideHover reports the failure in the popup; nothing to do here.
    }
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function swapLanguages(): Promise<void> {
    const cfg = config();
    const from = cfg.get<string>('sourceLanguage', 'auto')!;
    const to = cfg.get<string>('targetLanguage', 'vi')!;
    // 'auto' has no direction to swap into, so fall back to what was detected.
    const newTarget = from === 'auto' ? lastResult?.from ?? 'en' : from;
    await cfg.update('sourceLanguage', to, vscode.ConfigurationTarget.Global);
    await cfg.update('targetLanguage', newTarget, vscode.ConfigurationTarget.Global);
    updateStatusBar();
    await reopenPopup();
}

/* --------------------------------------------------------------- helpers */

function readSelection(editor: vscode.TextEditor): string {
    return prepare(editor.document.getText(editor.selection), config());
}

/**
 * Turns a code selection into something worth sending: comment markers and
 * per-line indentation are dropped, and the line structure is kept, folded or
 * flattened depending on `preserveLineBreaks`.
 */
function prepare(raw: string, cfg: vscode.WorkspaceConfiguration): string {
    let text = raw;

    if (cfg.get<boolean>('stripCommentMarkers', true)) {
        text = text
            .replace(/\/\*+|\*+\/|<!--|-->/g, ' ')
            .split('\n')
            .map(line => line.replace(/^\s*(\/\/+|#+|\*+|--)\s?/, ''))
            .join('\n');
    }

    const lines = text.split('\n').map(line => line.trim());

    switch (cfg.get<string>('preserveLineBreaks', 'all')) {
        case 'off':
            text = lines.join(' ');
            break;
        case 'paragraph':
            // Hard-wrapped lines are folded back into one sentence; only the
            // blank lines between paragraphs survive.
            text = lines
                .join('\n')
                .split(/\n{2,}/)
                .map(paragraph => paragraph.split('\n').join(' ').trim())
                .filter(paragraph => paragraph !== '')
                .join('\n\n');
            break;
        default:
            // Every line stays a line; runs of blank lines collapse into one.
            text = lines.join('\n').replace(/\n{3,}/g, '\n\n');
            break;
    }

    // Horizontal runs only — \s would eat the newlines just preserved above.
    return text.replace(/[^\S\n]{2,}/g, ' ').trim().slice(0, cfg.get<number>('maxLength', 2000)!);
}

function escapeMd(text: string): string {
    return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, m => `\\${m}`);
}
