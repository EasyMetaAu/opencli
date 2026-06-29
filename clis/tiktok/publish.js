import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, ArgumentError } from '@jackwener/opencli/errors';
import {
    buildDescriptionWithTags,
    PUBLISH_ERROR_CODES,
    classifyPlatformFailure,
    throwPublishFailure,
    requireBrowserUploadSupport,
    setFileInput,
    successResult,
    unsupportedResult,
    validateVideoPublishInput,
    visibleElementScript,
} from '../_shared/video-publish.js';

const PLATFORM = 'tiktok';
const DOMAIN = 'www.tiktok.com';
const UPLOAD_URL = 'https://www.tiktok.com/tiktokstudio/upload';
const FILE_SELECTORS = [
    'input[type="file"][accept*="video"]',
    'input[type="file"]',
];
const READY_TIMEOUT_MS = 180_000;
const READY_POLL_MS = 1500;
const CAPTION_READY_TIMEOUT_MS = 45_000;
const CAPTION_READY_POLL_MS = 500;
const SUBMIT_TIMEOUT_MS = 90_000;
const SUBMIT_POLL_MS = 1500;

function unsupportedForInput(input) {
    if (input.cover) {
        return unsupportedResult(PLATFORM, 'cover', 'TikTok cover selection is not automated yet; pass no --cover or handle cover manually.');
    }
    if (input.account) {
        return unsupportedResult(PLATFORM, 'account', 'TikTok account switching is not automated yet; use the active logged-in browser account.');
    }
    if (input.privacy !== 'public') {
        return unsupportedResult(PLATFORM, 'privacy', 'TikTok publish adapter currently supports public immediate publish only.');
    }
    if (input.draft) {
        return unsupportedResult(PLATFORM, 'draft', 'TikTok draft save is not automated yet; immediate publish is supported.');
    }
    return null;
}

// Parse the --schedule value into an absolute instant (epoch ms). We deliberately
// do NOT derive wall-clock fields here: the TikTok Studio picker shows the
// BROWSER's local time, so the Y/M/D/H/M to select must be computed browser-side
// from this instant (see setTikTokSchedule), never from the Node process timezone.
// Accepts ISO8601 (with Z/offset), epoch seconds, or epoch ms. Out-of-window times
// are not rejected here — the picker snaps them to the nearest available slot.
function parseScheduleInstant(raw) {
    const s = String(raw ?? '').trim();
    if (!s) throw new ArgumentError('tiktok schedule time is empty');
    let epochMs;
    if (/^\d+$/.test(s)) {
        const n = Number(s);
        epochMs = n < 1e12 ? n * 1000 : n; // seconds vs milliseconds heuristic
    } else {
        epochMs = new Date(s).getTime();
    }
    if (!Number.isFinite(epochMs)) {
        throw new ArgumentError(`tiktok could not parse schedule time: ${raw}`);
    }
    if (epochMs <= Date.now()) {
        throw new ArgumentError('tiktok schedule time must be in the future');
    }
    return { epochMs };
}

async function assertTikTokLoggedIn(page) {
    const state = await page.evaluate(`
        (() => {
            const text = (document.body?.innerText || '').replace(/\\s+/g, ' ');
            const url = location.href;
            const hasFileInput = !!document.querySelector('input[type="file"]');
            const loginLike = /log in|sign up|continue with google|继续|登录|注册/i.test(text);
            const uploadLike = /upload|select file|drag and drop|上传|选择文件/i.test(text) || hasFileInput;
            if (/\\/login/i.test(url) || (loginLike && !uploadLike)) {
                return { ok: false, message: 'TikTok Studio requires login' };
            }
            return { ok: true, url };
        })()
    `);
    if (!state?.ok) {
        throw new AuthRequiredError(DOMAIN, state?.message || 'TikTok Studio requires login');
    }
}

async function waitForUploadReady(page) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const result = await page.evaluate(`
            (() => {
                const text = (document.body?.innerText || '').replace(/\\s+/g, ' ');
                if (/failed|error|try again|上传失败|处理失败/i.test(text)) {
                    return { error: 'upload', message: text.slice(0, 300) };
                }
                // The editor (caption box + publish button) renders BEFORE the video bytes
                // finish uploading; clicking publish while still uploading is silently ignored.
                // So wait for the in-progress UI to clear, e.g. "4.15MB/4.2MB 还剩 0 秒 取消 99%".
                // Progress markers seen live: zh "4.15MB/4.2MB 还剩 0 秒 取消 99%",
                // en "42.02MB/42.45MB ... 0 seconds left ... Cancel ... 99%". The MB/MB form is
                // language-agnostic and only present while uploading (done shows "Uploaded (x)").
                const uploading = /还剩\\s*\\d|取消\\s*\\d{1,3}\\s*%|\\d+(?:\\.\\d+)?\\s*MB\\s*\\/\\s*\\d|uploading|seconds?\\s*left|\\bremaining\\b/i.test(text);
                const hasCaption = !!document.querySelector('[contenteditable="true"], textarea, input[type="text"]');
                const hasPost = Array.from(document.querySelectorAll('button, [role="button"]')).some((el) => {
                    const label = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
                    return /post|publish|发布|预约发布|立即发布/i.test(label);
                });
                const editorReady = hasCaption || hasPost || /已上传|uploaded|processing complete|publish settings|caption|描述|标题|发布设置/i.test(text);
                if (!uploading && editorReady) {
                    return { ok: true };
                }
                return null;
            })()
        `);
        if (result?.ok) return;
        classifyPlatformFailure(PLATFORM, DOMAIN, result, 'TikTok upload failed');
        await page.wait({ time: READY_POLL_MS / 1000 });
    }
    throwPublishFailure(PUBLISH_ERROR_CODES.uploadFailed, 'TikTok upload did not become editable before timeout');
}

const CAPTION_SELECTORS = [
    '[data-e2e="caption-input"] [contenteditable="true"]',
    '[data-e2e="caption-input"] textarea',
    '.public-DraftEditor-content',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
    'textarea',
];

// TikTok's caption box is a DraftJS editor: its text lives in React EditorState, NOT the DOM.
// setNativeText only rewrites textContent, so the model keeps its default (the uploaded file
// name) and the post ships the wrong caption. The reliable path is a real CDP click to
// activate the editor, select-all to mark the default text, then CDP Input.insertText to
// replace it through DraftJS's beforeinput handler. We verify the new text actually landed
// and retry, because DraftJS init can lag the upload-ready signal. Newlines are collapsed to
// spaces (TikTok captions are one free-text block; multi-line programmatic input is mangled).
async function fillTikTokCaption(page, text) {
    const caption = String(text).replace(/\s*\n+\s*/g, ' ').trim();
    const probe = caption.replace(/[#@]/g, '').slice(0, 12).trim();
    const findScript = `
        (() => {
            ${visibleElementScript()}
            const sels = ${JSON.stringify(CAPTION_SELECTORS)};
            let el = null;
            for (const s of sels) { el = Array.from(document.querySelectorAll(s)).find(isVisible); if (el) break; }
            return el;
        })`;

    const selectorScript = `
        (() => {
            ${visibleElementScript()}
            const sels = ${JSON.stringify(CAPTION_SELECTORS)};
            for (const s of sels) { if (Array.from(document.querySelectorAll(s)).find(isVisible)) return s; }
            return '';
        })()
    `;
    // DraftJS can mount a beat after waitForUploadReady's loose signal, especially on a
    // slower CDP/AdsPower browser, so poll for the editor instead of probing once.
    let sel = '';
    const captionDeadline = Date.now() + CAPTION_READY_TIMEOUT_MS;
    for (;;) {
        sel = await page.evaluate(selectorScript);
        if (sel || Date.now() >= captionDeadline) break;
        await page.wait({ time: CAPTION_READY_POLL_MS / 1000 });
    }
    if (!sel) {
        throwPublishFailure(PUBLISH_ERROR_CODES.platformError, 'TikTok caption editor was not found after upload');
    }

    let filled = false;
    for (let attempt = 0; attempt < 3 && !filled; attempt += 1) {
        try { await page.click(sel); } catch { /* real click is best-effort */ }
        await page.evaluate(`
            (() => {
                const el = ${findScript}();
                if (!el) return { ok: false };
                el.focus();
                if (el.isContentEditable) {
                    const s = window.getSelection();
                    const r = document.createRange();
                    r.selectNodeContents(el);
                    s.removeAllRanges();
                    s.addRange(r);
                } else if (el.select) {
                    el.select();
                }
                return { ok: true };
            })()
        `);
        if (typeof page.insertText === 'function') {
            await page.insertText(caption);
        } else {
            await page.evaluateWithArgs(`
                (() => {
                    ${visibleElementScript()}
                    const el = document.activeElement;
                    if (el) setNativeText(el, captionText);
                    return { ok: true };
                })()
            `, { captionText: caption });
        }
        await page.wait({ time: 0.5 });
        const check = await page.evaluateWithArgs(`
            (() => {
                const el = ${findScript}();
                const txt = el ? (el.textContent || el.value || '') : '';
                return { has: probe.length > 0 && txt.indexOf(probe) !== -1 };
            })()
        `, { probe });
        filled = check?.has === true;
    }
    if (!filled) {
        throwPublishFailure(PUBLISH_ERROR_CODES.platformError, 'TikTok caption was not accepted by the editor (DraftJS state did not update with the title/description)');
    }
}

// Select "预约发布" (Schedule) and drive TikTok Studio's date+time pickers to the
// target instant. Everything runs in ONE async evaluate so the session lease does
// not idle out and reset the tab between sub-steps (same constraint as the WeChat
// Channels picker). Selectors are locked from live recon of tiktokstudio/upload:
//   • schedule radio:  input[name=postSchedule][value=schedule]   (post_now = immediate)
//   • date/time field: input.TUXTextInputCore-input (readonly; value is ISO date or HH:MM)
//   • calendar:        .calendar-wrapper → .month-title/.year-title, .month-header-wrapper .arrow
//                      ([0]=prev month, [1]=next month), day cells span.day (.valid = selectable)
//   • time dropdown:   .tiktok-timepicker-time-picker-container → option spans
//                      .tiktok-timepicker-left (hours 00-23) / .tiktok-timepicker-right (minutes,
//                      5-min grid 00,05,…,55); .tiktok-timepicker-is-active marks the current pick
// Wall-clock fields are derived browser-side from the absolute instant so they match
// what the picker shows (browser timezone), never the Node process timezone. Minutes
// snap to the nearest 5-min grid value and out-of-grid days snap to the nearest
// selectable day; the actually-selected date/time is read back so the caller can
// report it (no silent adjustment).
async function setTikTokSchedule(page, raw) {
    const { epochMs } = parseScheduleInstant(raw);
    const result = await page.evaluateWithArgs(`
        (async () => {
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
            const fire = (el, t) => el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
            const click = (el) => { fire(el, 'mousedown'); fire(el, 'mouseup'); el.click(); };
            const pad = (n) => String(n).padStart(2, '0');
            const fmt = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());

            const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'local';
            const requested = fmt(new Date(epochMs));
            // Snap minutes to the 5-min grid; setMinutes carries hour/day correctly.
            const target = new Date(epochMs);
            let rounded = false;
            const m0 = target.getMinutes();
            const m5 = Math.round(m0 / 5) * 5;
            if (m5 !== m0) { target.setMinutes(m5, 0, 0); rounded = true; } else { target.setSeconds(0, 0); }
            const TY = target.getFullYear(), TM = target.getMonth() + 1, TD = target.getDate();
            const TH = target.getHours(), TMin = target.getMinutes();
            const wantDate = TY + '-' + pad(TM) + '-' + pad(TD);
            const wantTime = pad(TH) + ':' + pad(TMin);

            // 1) Enable scheduled publish.
            const sr = document.querySelector('input[name="postSchedule"][value="schedule"]');
            if (!sr) return { ok: false, reason: 'no-schedule-radio' };
            click(sr);
            await sleep(800);

            const findInputs = () => Array.from(document.querySelectorAll('input.TUXTextInputCore-input'));
            const reDate = /^\\d{4}-\\d{2}-\\d{2}$/;
            const reTime = /^\\d{1,2}:\\d{2}$/;

            // 2) Date — open the calendar, navigate to the target month, pick the day.
            let di = findInputs().find((i) => reDate.test(i.value));
            if (!di) return { ok: false, reason: 'no-date-input', vals: findInputs().map((i) => i.value) };
            click(di);
            await sleep(500);
            const cal = document.querySelector('.calendar-wrapper');
            if (!cal) return { ok: false, reason: 'no-calendar' };
            const cnMonth = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10, '十一': 11, '十二': 12 };
            const enMonth = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
            // Read the whole header text so this works whether the panel renders Chinese
            // ("六月 / 2026") or English ("June 2026"): month via CJK char / English abbrev /
            // numeric, year via the 4-digit run.
            const headerText = () => {
                const hdr = cal.querySelector('.month-header-wrapper');
                if (hdr) return norm(hdr.textContent);
                return norm(((cal.querySelector('.month-title') || {}).textContent || '') + ' ' + ((cal.querySelector('.year-title') || {}).textContent || ''));
            };
            const panelYM = () => {
                const t = headerText();
                const ym = t.match(/\\d{4}/);
                const yr = ym ? Number(ym[0]) : null;
                let mo = null;
                const cnKey = (t.match(/[一二三四五六七八九十]+(?=月)/) || [])[0];
                if (cnKey && cnMonth[cnKey]) mo = cnMonth[cnKey];
                if (!mo) { const i = enMonth.findIndex((x) => t.toLowerCase().includes(x)); if (i >= 0) mo = i + 1; }
                if (!mo) { const dm = t.match(/(\\d{1,2})\\s*月/); if (dm) mo = Number(dm[1]); }
                return (mo && yr) ? { yr, mo } : null;
            };
            const targetYM = TY * 12 + (TM - 1);
            let guard = 0;
            while (guard++ < 48) {
                const p = panelYM();
                if (!p) return { ok: false, reason: 'panel-parse', mt: headerText() };
                const cur = p.yr * 12 + (p.mo - 1);
                if (cur === targetYM) break;
                const arrows = cal.querySelectorAll('.month-header-wrapper .arrow');
                const arrow = cur < targetYM ? arrows[1] : arrows[0];
                if (!arrow) return { ok: false, reason: 'no-arrow' };
                click(arrow);
                await sleep(300);
            }
            const daySpans = () => Array.from(cal.querySelectorAll('.day-span-container span.day'));
            let cands = daySpans().filter((s) => norm(s.textContent) === String(TD) && /\\bvalid\\b/.test(s.className));
            let snapDay = false;
            if (!cands.length) {
                const valid = daySpans().filter((s) => /\\bvalid\\b/.test(s.className));
                if (!valid.length) return { ok: false, reason: 'no-valid-day', day: TD };
                cands = [valid[0]];
                snapDay = true;
            }
            click(cands[0]);
            await sleep(400);
            if (snapDay) rounded = true;
            di = findInputs().find((i) => reDate.test(i.value)) || di;
            const selectedDate = di.value;

            // 3) Time — the TUX timepicker is a SCROLL picker: a single click scroll-snaps and
            // can land on the wrong slot, so pick hour+minute, read back the settled value, and
            // retry until it equals the wanted time or converges (i.e. snapped to the nearest
            // available slot). Reading too eagerly catches a mid-scroll value, hence readTime().
            let ti = findInputs().find((i) => reTime.test(i.value));
            if (!ti) return { ok: false, reason: 'no-time-input' };
            const wantTimeStr = pad(TH) + ':' + pad(TMin);
            const pickClick = (col, val) => {
                const tc = document.querySelector('.tiktok-timepicker-time-picker-container');
                if (!tc) return { miss: 'no-dropdown' };
                const opts = Array.from(tc.querySelectorAll('span.tiktok-timepicker-option-text.' + col));
                if (!opts.length) return { miss: 'no-options' };
                let el = opts.find((o) => norm(o.textContent) === val);
                let snapped = false;
                if (!el) {
                    const tn = parseInt(val, 10);
                    const nums = opts.map((o) => ({ o, n: parseInt(norm(o.textContent), 10) }))
                        .filter((x) => !Number.isNaN(x.n))
                        .sort((a, b) => Math.abs(a.n - tn) - Math.abs(b.n - tn));
                    if (!nums.length) return { miss: 'no-options' };
                    el = nums[0].o;
                    snapped = norm(el.textContent) !== val;
                }
                el.scrollIntoView({ block: 'center' });
                click(el);
                return { snapped };
            };
            const readTime = async () => {
                let lastT = null;
                let stable = 0;
                for (let i = 0; i < 16; i += 1) {
                    await sleep(150);
                    const cur = (findInputs().find((x) => reTime.test(x.value)) || {}).value || '';
                    if (cur === lastT) { stable += 1; if (stable >= 3) break; } else { stable = 0; lastT = cur; }
                }
                return lastT || '';
            };
            let selectedTime = '';
            let prevSel = null;
            for (let attempt = 0; attempt < 5; attempt += 1) {
                if (!document.querySelector('.tiktok-timepicker-time-picker-container')) { click(ti); await sleep(450); }
                const H = pickClick('tiktok-timepicker-left', pad(TH));
                if (H.miss) return { ok: false, reason: 'hour-' + H.miss, hour: pad(TH) };
                await sleep(450);
                const M = pickClick('tiktok-timepicker-right', pad(TMin));
                if (M.miss) return { ok: false, reason: 'minute-' + M.miss, minute: pad(TMin) };
                await sleep(200);
                if (H.snapped || M.snapped) rounded = true;
                selectedTime = await readTime();
                if (selectedTime === wantTimeStr) break;
                if (selectedTime && selectedTime === prevSel) break; // converged → nearest slot
                prevSel = selectedTime;
                ti = findInputs().find((i) => reTime.test(i.value)) || ti;
                click(ti); // reopen the dropdown for another attempt
                await sleep(450);
            }
            if (selectedTime && selectedTime !== wantTimeStr) rounded = true;

            return { ok: true, tz, requested, wantDate, wantTime, selectedDate, selectedTime, rounded };
        })()
    `, { epochMs });

    if (!result?.ok) {
        try { await page.screenshot({ path: '/tmp/tiktok_schedule_debug.png' }); } catch { /* screenshot is best-effort */ }
        throwPublishFailure(
            PUBLISH_ERROR_CODES.platformError,
            `TikTok schedule picker failed (${result?.reason || 'empty result'}); screenshot: /tmp/tiktok_schedule_debug.png`,
        );
    }
    return result;
}

async function clickTikTokPublish(page, { scheduled = false } = {}) {
    // Scheduled mode relabels the primary button "预约发布" (recon). clickByLabels only
    // walks button-like nodes, so it never mistakes the same-text radio label for the
    // submit button; "发布" is kept as a substring fallback.
    const labels = scheduled
        ? ['预约发布', 'Schedule', 'Schedule video', '排程', '定时发布', 'Post', 'Publish', '发布']
        : ['Post', 'Publish', '发布', '立即发布'];
    // After setTikTokSchedule, TikTok briefly disables the submit button while it
    // validates the chosen time, so poll until clickByLabels lands a click.
    const deadline = Date.now() + 20_000;
    let result = null;
    while (Date.now() < deadline) {
        result = await page.evaluateWithArgs(`
            (() => {
                ${visibleElementScript()}
                return clickByLabels(labels);
            })()
        `, { labels });
        if (result?.ok) break;
        await page.wait({ time: 0.6 });
    }
    if (!result?.ok) {
        throwPublishFailure(PUBLISH_ERROR_CODES.platformError, result?.message || 'TikTok publish button was not found');
    }
    // TikTok often interrupts with a "继续发布？" dialog when the copyright check has not
    // finished ("版权检查未完成…仍要发布？"). Its confirm button is "立即发布"; clicking it
    // submits with the schedule intact. The dialog appears a beat after the submit click and
    // may not appear at all (check already done → page redirects straight to /content).
    const confirmDeadline = Date.now() + 12_000;
    while (Date.now() < confirmDeadline) {
        const step = await page.evaluate(`
            (() => {
                ${visibleElementScript()}
                if (/tiktokstudio\\/content/i.test(location.href)) return { done: true };
                // Only act inside an actual dialog so we never mis-click a page button when no
                // confirm prompt is showing (the submit click already went through in that case).
                const modal = document.querySelector('[role="dialog"], [aria-modal="true"], [class*="modal"], [class*="Modal"]');
                if (!modal) return { ok: false };
                const btns = Array.from(modal.querySelectorAll('button, [role="button"]'));
                for (const label of ['立即发布', '继续发布', 'Post now', 'Schedule now', 'Publish now', 'Post anyway', 'Publish anyway', 'Continue']) {
                    const needle = label.toLowerCase();
                    for (const el of btns) {
                        const t = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
                        const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
                        if (!disabled && isVisible(el) && t.includes(needle)) { el.click(); return { confirmed: label }; }
                    }
                }
                return { ok: false };
            })()
        `);
        if (step?.done || step?.confirmed) return;
        await page.wait({ time: 0.5 });
    }
    // No confirm dialog and no redirect within the window — leave result detection to
    // waitForTikTokPublishResult, which polls longer for the success signal.
}

async function waitForTikTokPublishResult(page, { scheduled = false } = {}) {
    const deadline = Date.now() + SUBMIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const result = await page.evaluateWithArgs(`
            (() => {
                const text = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
                const url = location.href;
                if (scheduled) {
                    // A scheduled post has no public /video/ URL yet; success is the redirect to
                    // the content manager or a scheduling toast.
                    if (/tiktokstudio\\/content/i.test(url)) {
                        return { ok: true, url: '', message: 'TikTok scheduled publish completed' };
                    }
                    if (/your video will be (published|scheduled|posted)|scheduled for|video scheduled|预约成功|已预约|定时发布成功|已设置定时|将于.*发布|已排程/i.test(text)) {
                        return { ok: true, url: '', message: 'TikTok scheduled publish completed' };
                    }
                } else {
                    const anchors = Array.from(document.querySelectorAll('a[href*="/video/"]')).map((a) => a.href).filter(Boolean);
                    if (anchors.length) return { ok: true, url: anchors[0], message: 'TikTok publish completed' };
                    if (/successfully posted|published successfully|post has been published|发布成功|已发布/i.test(text)) {
                        return { ok: true, url: '', message: 'TikTok publish completed' };
                    }
                }
                if (/log in|session expired|please login|请登录|登录已过期/i.test(text)) {
                    return { error: 'auth', message: 'TikTok login expired during publish' };
                }
                if (/failed|try again|violat|not eligible|上传失败|发布失败|违规|稍后再试/i.test(text)) {
                    return { error: 'platform', message: text.slice(0, 500) };
                }
                return null;
            })()
        `, { scheduled });
        if (result?.ok) return result;
        classifyPlatformFailure(PLATFORM, DOMAIN, result, scheduled ? 'TikTok scheduled publish failed' : 'TikTok publish failed');
        await page.wait({ time: SUBMIT_POLL_MS / 1000 });
    }
    throwPublishFailure(PUBLISH_ERROR_CODES.platformError, `TikTok ${scheduled ? 'scheduled ' : ''}publish button clicked but result was unclear before timeout; check TikTok Studio manually.`);
}

export const publishCommand = cli({
    site: 'tiktok',
    name: 'publish',
    access: 'write',
    description: 'Publish a local video to TikTok Studio and return a structured result',
    domain: DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: UPLOAD_URL,
    args: [
        { name: 'video', required: true, positional: true, help: 'Local video file path (mp4/mov/m4v/webm)' },
        { name: 'title', required: true, help: 'Video title/caption prefix' },
        { name: 'description', default: '', help: 'Video description appended after title' },
        { name: 'tags', default: '', help: 'Comma-separated hashtags; written into the caption as #tags' },
        { name: 'cover', default: '', help: 'Cover image path (currently returns unsupported_capability)' },
        { name: 'schedule', default: '', help: 'Scheduled publish time as ISO8601 (with Z/offset) or epoch seconds/ms; resolved in the browser timezone, minutes snap to TikTok\'s 5-min grid' },
        { name: 'privacy', default: 'public', choices: ['public', 'friends', 'private'], help: 'Privacy setting; currently only public is automated' },
        { name: 'account', default: '', help: 'Account selector (currently returns unsupported_capability)' },
        { name: 'draft', type: 'bool', default: false, help: 'Save as draft (currently returns unsupported_capability)' },
        { name: 'timeout', type: 'int', default: 180, help: 'Max seconds for the overall command; scheduled publish needs headroom for upload + schedule + the copyright-check confirm dialog (default: 180)' },
    ],
    columns: ['ok', 'platform', 'status', 'code', 'capability', 'message', 'url', 'draft'],
    func: async (page, kwargs) => {
        const input = validateVideoPublishInput(kwargs, PLATFORM, {
            maxTitleLength: 300,
            maxDescriptionLength: 1900,
            validateCover: false,
        });
        const unsupported = unsupportedForInput(input);
        if (unsupported) return unsupported;

        await requireBrowserUploadSupport(page, PLATFORM);
        await page.goto(UPLOAD_URL, { waitUntil: 'load', settleMs: 3000 });
        await assertTikTokLoggedIn(page);
        await setFileInput(page, [input.videoPath], FILE_SELECTORS, PLATFORM);
        await waitForUploadReady(page);

        const caption = [input.title, buildDescriptionWithTags(input.description, input.tags)].filter(Boolean).join('\n\n');
        await fillTikTokCaption(page, caption);

        const scheduled = Boolean(input.schedule);
        let scheduledInfo = null;
        if (scheduled) {
            scheduledInfo = await setTikTokSchedule(page, input.schedule);
        }

        await clickTikTokPublish(page, { scheduled });
        const publishResult = await waitForTikTokPublishResult(page, { scheduled });

        const message = scheduledInfo
            ? `TikTok scheduled for ${scheduledInfo.selectedDate} ${scheduledInfo.selectedTime} (${scheduledInfo.tz})`
                + (scheduledInfo.rounded ? `; requested ${scheduledInfo.requested}, snapped to nearest available slot` : '')
            : (publishResult.message || 'TikTok publish completed');

        return successResult(PLATFORM, message, {
            url: publishResult.url || '',
            draft: false,
        });
    },
});

export const __test__ = {
    unsupportedForInput,
    fillTikTokCaption,
    waitForTikTokPublishResult,
    parseScheduleInstant,
    setTikTokSchedule,
    clickTikTokPublish,
};
