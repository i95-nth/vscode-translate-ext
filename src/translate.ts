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

/** One request, already split into the lines that must stay separate. */
interface SegmentRequest {
    segments: string[];
    from: string;
    to: string;
    apiKey?: string;
    host?: string;
}

interface SegmentResult {
    texts: string[];
    detectedSource: string;
}

const cache = new Map<string, TranslateResult>();
const MAX_CACHE_ENTRIES = 500;

/**
 * Both free endpoints take the text in the query string and answer anything
 * past ~16 KB (16384) with a 400, then a 413. Measured against the live hosts:
 * 15,092 bytes still returns 200, 16,457 does not. Staying a little under the
 * cliff turns an opaque HTTP error into an answerable message — a CJK
 * character costs 9 bytes once encoded, so the ceiling arrives far sooner than
 * the character count suggests.
 */
const MAX_URL_BYTES = 16000;

function guardUrlLength(url: string): void {
    if (url.length > MAX_URL_BYTES) {
        throw new Error(
            'Selection is too long for the free Google endpoint. ' +
                'Lower translateHover.maxLength, or set translateHover.apiKey to use the official API.'
        );
    }
}

export function clearCache(): void {
    cache.clear();
}

/** Whether this exact request would be answered without touching the network. */
export function isCached(opts: TranslateOptions): boolean {
    return cache.has(cacheKey(opts));
}

function cacheKey(opts: TranslateOptions): string {
    return `${opts.from}|${opts.to}|${opts.text}`;
}

export async function translate(opts: TranslateOptions): Promise<TranslateResult> {
    const key = cacheKey(opts);
    const cached = cache.get(key);
    if (cached) {
        return cached;
    }

    // Every line is translated on its own so the layout of the source text
    // survives the round trip; blank lines are kept but never sent.
    const lines = opts.text.split('\n');
    const filled = lines.map((line, index) => ({ line, index })).filter(l => l.line.trim() !== '');
    if (filled.length === 0) {
        return { text: opts.text, detectedSource: opts.from };
    }

    const request: SegmentRequest = {
        segments: filled.map(l => l.line),
        from: opts.from,
        to: opts.to,
        apiKey: opts.apiKey,
        host: opts.host
    };

    const segments = opts.apiKey ? await translateOfficial(request) : await translateFree(request);

    let text: string;
    if (segments.texts.length === filled.length) {
        const out = lines.slice();
        filled.forEach((l, n) => {
            out[l.index] = segments.texts[n];
        });
        text = out.join('\n');
    } else {
        // The engine re-cut the text its own way; show what it gave back
        // rather than mapping translations onto the wrong lines.
        text = segments.texts.join('\n');
    }

    const result: TranslateResult = { text, detectedSource: segments.detectedSource };

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
async function translateFree(req: SegmentRequest): Promise<SegmentResult> {
    try {
        return await translateChromeEndpoint(req);
    } catch (err) {
        try {
            return await translateWidgetEndpoint(req);
        } catch {
            // Surface the first failure: it is the endpoint we actually prefer.
            throw err;
        }
    }
}

async function translateChromeEndpoint(req: SegmentRequest): Promise<SegmentResult> {
    const host = req.host || 'clients5.google.com';
    // One q per line: the endpoint answers with one entry per q, in order.
    const url =
        `https://${host}/translate_a/t?client=dict-chrome-ex` +
        `&sl=${encodeURIComponent(req.from)}` +
        `&tl=${encodeURIComponent(req.to)}` +
        req.segments.map(s => `&q=${encodeURIComponent(s)}`).join('');
    guardUrlLength(url);

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

    const texts: string[] = [];
    let detected = req.from;
    for (const entry of data) {
        if (typeof entry === 'string') {
            texts.push(entry);
        } else if (Array.isArray(entry) && typeof entry[0] === 'string') {
            texts.push(entry[0]);
            if (typeof entry[1] === 'string') {
                detected = entry[1];
            }
        }
    }

    if (texts.every(t => !t)) {
        throw new Error('Empty response from Google Translate');
    }

    // A single q that came back cut into chunks belongs back together.
    if (req.segments.length === 1 && texts.length > 1) {
        return { texts: [texts.join('')], detectedSource: detected };
    }
    return { texts, detectedSource: detected };
}

async function translateWidgetEndpoint(req: SegmentRequest): Promise<SegmentResult> {
    // client=at (the Android app identifier). The older client=gtx is now
    // answered with a hard 429 anti-abuse page on every host and path.
    // This one takes a single q, so the lines go over as one block and the
    // newlines Google echoes back are what splits them again.
    const url =
        'https://translate.googleapis.com/translate_a/single?client=at' +
        `&sl=${encodeURIComponent(req.from)}` +
        `&tl=${encodeURIComponent(req.to)}` +
        `&dt=t&dj=1&q=${encodeURIComponent(req.segments.join('\n'))}`;
    guardUrlLength(url);

    const res = await fetchWithTimeout(url);
    if (!res.ok) {
        throw new Error(`Google Translate returned HTTP ${res.status}`);
    }

    const data = (await res.json()) as { sentences?: { trans?: string }[]; src?: string };
    const text = (data.sentences ?? []).map(s => s.trans ?? '').join('');
    if (!text) {
        throw new Error('Empty response from Google Translate');
    }

    const detectedSource = data.src || req.from;
    const parts = text.split('\n').map(s => s.trim()).filter(s => s !== '');
    return {
        texts: parts.length === req.segments.length ? parts : [text.trim()],
        detectedSource
    };
}

/**
 * Official Cloud Translation API v2, used when the user supplies a key.
 *
 * The key travels in `X-Goog-Api-Key` rather than the `?key=` query parameter
 * both forms accept: a corporate proxy doing TLS inspection records full URLs,
 * so a key in the query string ends up in someone's logs.
 */
async function translateOfficial(req: SegmentRequest): Promise<SegmentResult> {
    const url = 'https://translation.googleapis.com/language/translate/v2';
    const body: Record<string, unknown> = {
        q: req.segments,
        target: req.to,
        format: 'text'
    };
    if (req.from && req.from !== 'auto') {
        body.source = req.from;
    }

    const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': req.apiKey! },
        body: JSON.stringify(body)
    });

    const payload = (await res.json()) as {
        data?: { translations?: { translatedText?: string; detectedSourceLanguage?: string }[] };
        error?: { message?: string };
    };

    if (!res.ok) {
        throw new Error(payload.error?.message || `Cloud Translation API returned HTTP ${res.status}`);
    }

    const hits = payload.data?.translations ?? [];
    const texts = hits.map(h => h.translatedText ?? '');
    if (texts.every(t => !t)) {
        throw new Error('Empty response from Cloud Translation API');
    }
    return { texts, detectedSource: hits[0]?.detectedSourceLanguage || req.from };
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
