import * as vscode from 'vscode';
import { LANGUAGES, Language, languageName } from './languages';
import { clearCache, translate, ttsUrl, webUrl } from './translate';

const SECTION = 'translateHover';

let iconDecoration: vscode.TextEditorDecorationType;
let statusBar: vscode.StatusBarItem;
let selectionTimer: NodeJS.Timeout | undefined;
let lastResult: { source: string; translated: string; from: string; to: string } | undefined;
let output: vscode.OutputChannel;
let state: vscode.Memento | undefined;

export function activate(context: vscode.ExtensionContext): void {
    output = vscode.window.createOutputChannel('Translate Hover');
    state = context.globalState;

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

    if (!cfg.get<boolean>('showIconOnSelect', true) || selection.isEmpty || !readSelection(editor)) {
        editor.setDecorations(iconDecoration, []);
        return;
    }

    // The icon is injected after the last selected character.
    editor.setDecorations(iconDecoration, [new vscode.Range(selection.end, selection.end)]);

    if (cfg.get<boolean>('autoShowPopup', false)) {
        void vscode.commands.executeCommand('editor.action.showHover');
    }
}

/* ----------------------------------------------------------------- hover */

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

    const from = cfg.get<string>('sourceLanguage', 'auto')!;
    const to = cfg.get<string>('targetLanguage', 'vi')!;

    output.appendLine(`[hover] ${from} -> ${to} :: ${text.slice(0, 60)}`);

    try {
        const result = await translate({
            text,
            from,
            to,
            apiKey: cfg.get<string>('apiKey') || undefined,
            host: cfg.get<string>('proxy') || undefined
        });
        if (token.isCancellationRequested) {
            return undefined;
        }
        lastResult = { source: text, translated: result.text, from: result.detectedSource, to };
        return new vscode.Hover(buildPopup(text, result.text, result.detectedSource, to), range);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output.appendLine(`[${new Date().toISOString()}] ${message}`);
        const md = new vscode.MarkdownString(`$(error) **Translate failed** — ${escapeMd(message)}`);
        md.supportThemeIcons = true;
        return new vscode.Hover(md, range);
    }
}

/** Builds the popup body, mirroring the Google Translate bubble layout. */
function buildPopup(source: string, translated: string, from: string, to: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

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

    md.appendMarkdown(
        `[$(unmute)](${link('speak', [source, from])} "Listen") ${escapeMd(collapse(source, 220))}\n\n`
    );

    md.appendMarkdown('---\n\n');

    md.appendMarkdown(
        `[$(unmute)](${link('speak', [translated, to])} "Listen") **${escapeMd(collapse(translated, 600))}**\n\n`
    );

    const quick = quickLanguageRow(to, link);
    if (quick) {
        md.appendMarkdown(`${quick}\n\n`);
    }

    md.appendMarkdown(
        `[$(copy) Copy](${link('copyLastResult', [])} "Copy translation") &nbsp;·&nbsp; ` +
            `[$(replace-all) Replace](${link('replaceSelection', [])} "Replace selection with translation") &nbsp;·&nbsp; ` +
            `[$(link-external) More »](${link('openInBrowser', [source, from, to])} "Open in Google Translate")`
    );

    return md;
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

async function translateSelectionCommand(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }
    if (editor.selection.isEmpty) {
        vscode.window.showInformationMessage('Translate Hover: select some text first.');
        return;
    }
    renderDecoration(editor);
    await vscode.commands.executeCommand('editor.action.showHover');
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

    try {
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: 'Translating…' },
            () =>
                translate({
                    text,
                    from: cfg.get<string>('sourceLanguage', 'auto')!,
                    to: cfg.get<string>('targetLanguage', 'vi')!,
                    apiKey: cfg.get<string>('apiKey') || undefined,
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
    await prefetch(editor);

    // Re-showing a hover at the position it was just dismissed at hands back
    // the result computed for the previous language pair. Dropping it and
    // moving the cursor off the spot and back invalidates that — the same
    // thing the user was doing by hand when reselecting the text.
    await vscode.commands.executeCommand('editor.action.hideHover');

    const selection = editor.selection;
    editor.selection = new vscode.Selection(selection.active, selection.active);
    await delay(0);
    editor.selection = selection;

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
    try {
        await translate({
            text,
            from: cfg.get<string>('sourceLanguage', 'auto')!,
            to: cfg.get<string>('targetLanguage', 'vi')!,
            apiKey: cfg.get<string>('apiKey') || undefined,
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
 * per-line indentation are dropped and hard-wrapped lines are joined.
 */
function prepare(raw: string, cfg: vscode.WorkspaceConfiguration): string {
    let text = raw;

    if (cfg.get<boolean>('stripCommentMarkers', true)) {
        text = text
            .replace(/\/\*+|\*+\/|<!--|-->/g, ' ')
            .split('\n')
            .map(line => line.replace(/^\s*(\/\/+|#+|\*+|--)\s?/, '').trim())
            .join('\n');
    }

    return text.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, cfg.get<number>('maxLength', 2000)!);
}

function collapse(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

function escapeMd(text: string): string {
    return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, m => `\\${m}`);
}
