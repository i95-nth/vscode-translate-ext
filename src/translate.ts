export interface TranslateOptions {
    text: string;
    from: string;
    to: string;
    apiKey?: string;
    host?: string;
}

export interface TranslateResult {
    text: string;
    detectedSource: string;
}

const cache = new Map<string, TranslateResult>();
const MAX_CACHE_ENTRIES = 500;

export function clearCache(): void {
    cache.clear();
}

export async function translate(opts: TranslateOptions): Promise<TranslateResult> {
    const key = `${opts.from}|${opts.to}|${opts.text}`;
    const cached = cache.get(key);
    if (cached) {
        return cached;
    }

    const result = opts.apiKey ? await translateOfficial(opts) : await translateFree(opts);

    if (cache.size >= MAX_CACHE_ENTRIES) {
        // Cheapest possible eviction: drop the oldest inserted entry.
        const oldest = cache.keys().next();
        if (!oldest.done) {
            cache.delete(oldest.value);
        }
    }
    cache.set(key, result);
    return result;
}

/**
 * Free, unofficial endpoints. No key required, but they are rate limited and
 * can break without notice, so two of them are tried in order:
 *   1. clients5 + client=dict-chrome-ex — what the Google Translate Chrome
 *      extension talks to.
 *   2. translate_a/single + client=at — the Android app endpoint, richer JSON.
 */
async function translateFree(opts: TranslateOptions): Promise<TranslateResult> {
    try {
        return await translateChromeEndpoint(opts);
    } catch (err) {
        try {
            return await translateWidgetEndpoint(opts);
        } catch {
            // Surface the first failure: it is the endpoint we actually prefer.
            throw err;
        }
    }
}

async function translateChromeEndpoint(opts: TranslateOptions): Promise<TranslateResult> {
    const host = opts.host || 'clients5.google.com';
    const url =
        `https://${host}/translate_a/t?client=dict-chrome-ex` +
        `&sl=${encodeURIComponent(opts.from)}` +
        `&tl=${encodeURIComponent(opts.to)}` +
        `&q=${encodeURIComponent(opts.text)}`;

    const res = await fetchWithTimeout(url);
    if (!res.ok) {
        throw new Error(`Google Translate returned HTTP ${res.status}`);
    }

    // Two shapes, depending on whether the source language was auto-detected:
    //   sl=auto  ->  [["translated", "en"], ...]
    //   sl=en    ->  ["translated", ...]
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) {
        throw new Error('Unexpected response from Google Translate');
    }

    let text = '';
    let detected = opts.from;
    for (const entry of data) {
        if (typeof entry === 'string') {
            text += entry;
        } else if (Array.isArray(entry) && typeof entry[0] === 'string') {
            text += entry[0];
            if (typeof entry[1] === 'string') {
                detected = entry[1];
            }
        }
    }

    if (!text) {
        throw new Error('Empty response from Google Translate');
    }
    return { text, detectedSource: detected };
}

async function translateWidgetEndpoint(opts: TranslateOptions): Promise<TranslateResult> {
    // client=at (the Android app identifier). The older client=gtx is now
    // answered with a hard 429 anti-abuse page on every host and path.
    const url =
        'https://translate.googleapis.com/translate_a/single?client=at' +
        `&sl=${encodeURIComponent(opts.from)}` +
        `&tl=${encodeURIComponent(opts.to)}` +
        `&dt=t&dj=1&q=${encodeURIComponent(opts.text)}`;

    const res = await fetchWithTimeout(url);
    if (!res.ok) {
        throw new Error(`Google Translate returned HTTP ${res.status}`);
    }

    const data = (await res.json()) as { sentences?: { trans?: string }[]; src?: string };
    const text = (data.sentences ?? []).map(s => s.trans ?? '').join('');
    if (!text) {
        throw new Error('Empty response from Google Translate');
    }
    return { text, detectedSource: data.src || opts.from };
}

/** Official Cloud Translation API v2, used when the user supplies a key. */
async function translateOfficial(opts: TranslateOptions): Promise<TranslateResult> {
    const url = `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(opts.apiKey!)}`;
    const body: Record<string, string> = {
        q: opts.text,
        target: opts.to,
        format: 'text'
    };
    if (opts.from && opts.from !== 'auto') {
        body.source = opts.from;
    }

    const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    const payload = (await res.json()) as {
        data?: { translations?: { translatedText?: string; detectedSourceLanguage?: string }[] };
        error?: { message?: string };
    };

    if (!res.ok) {
        throw new Error(payload.error?.message || `Cloud Translation API returned HTTP ${res.status}`);
    }

    const hit = payload.data?.translations?.[0];
    if (!hit?.translatedText) {
        throw new Error('Empty response from Cloud Translation API');
    }
    return { text: hit.translatedText, detectedSource: hit.detectedSourceLanguage || opts.from };
}

async function fetchWithTimeout(url: string, init?: RequestInit, ms = 10000): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        return await fetch(url, {
            ...init,
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; vscode-translate-hover)',
                ...(init?.headers as Record<string, string> | undefined)
            }
        });
    } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
            throw new Error('Translation request timed out');
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

/** URL of Google's TTS audio for a chunk of text (max ~200 chars). */
export function ttsUrl(text: string, lang: string): string {
    const clipped = text.slice(0, 200);
    return (
        'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob' +
        `&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(clipped)}`
    );
}

export function webUrl(text: string, from: string, to: string): string {
    return (
        'https://translate.google.com/?op=translate' +
        `&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}` +
        `&text=${encodeURIComponent(text)}`
    );
}
