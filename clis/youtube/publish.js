import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError } from '@jackwener/opencli/errors';
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

const PLATFORM = 'youtube';
const DOMAIN = 'studio.youtube.com';
const STUDIO_URL = 'https://studio.youtube.com';
const FILE_SELECTORS = [
    'input[type="file"][accept*="video"]',
    'input[type="file"]',
];
const POLL_MS = 1500;
const DIALOG_TIMEOUT_MS = 60_000;
const PUBLISH_TIMEOUT_MS = 120_000;

function debugPublish(msg) {
    if (process.env.OPENCLI_DEBUG_PUBLISH) {
        process.stderr.write(`[youtube publish][debug] ${msg}\n`);
    }
}

function unsupportedForInput(input) {
    if (input.schedule) {
        return unsupportedResult(PLATFORM, 'schedule', 'YouTube publish adapter currently supports immediate publish only; scheduled publish is reported as unsupported.');
    }
    if (input.cover) {
        return unsupportedResult(PLATFORM, 'cover', 'YouTube thumbnail/cover upload is not automated yet; pass no --cover or handle thumbnail manually.');
    }
    if (input.account) {
        return unsupportedResult(PLATFORM, 'account', 'YouTube account/channel switching is not automated yet; use the active Studio channel.');
    }
    if (input.draft) {
        return unsupportedResult(PLATFORM, 'draft', 'YouTube explicit draft save is not automated yet; immediate publish is supported.');
    }
    return null;
}

async function assertYouTubeLoggedIn(page) {
    const state = await page.evaluate(`
        (() => {
            const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
            const url = location.href;
            if (/accounts\.google\.com|ServiceLogin/i.test(url) || /sign in|登录/i.test(text) && !/channel dashboard|studio|内容|信息中心/i.test(text)) {
                return { ok: false, message: 'YouTube Studio requires login' };
            }
            return { ok: true, url };
        })()
    `);
    if (!state?.ok) {
        throw new AuthRequiredError(DOMAIN, state?.message || 'YouTube Studio requires login');
    }
}

async function openUploadDialog(page) {
    const directInput = await page.evaluate(`(() => !!document.querySelector('input[type="file"]'))()`);
    if (directInput) return;

    const clicked = await page.evaluate(`
        (() => {
            ${visibleElementScript()}
            const direct = clickByLabels(['Upload videos', '上传视频']);
            if (direct.ok) return direct;
            const create = clickByLabels(['Create', '创建']);
            return create;
        })()
    `);
    if (clicked?.ok) {
        await page.wait({ time: 1 });
        const uploadClicked = await page.evaluate(`
            (() => {
                ${visibleElementScript()}
                return clickByLabels(['Upload videos', '上传视频']);
            })()
        `);
        if (uploadClicked?.ok) return;
    }
}

async function waitForDetailsDialog(page) {
    // The upload dialog (`<ytcp-uploads-dialog>`) uses Shady DOM, so its inner
    // text never reaches document.body.innerText — the old "body text mentions
    // 详情/标题 + a textbox exists" check could never pass on a zh-CN (or any
    // Shady-DOM) Studio and timed out. Detect readiness by the dialog's stable
    // `workflow-step` reaching DETAILS instead. Auth / upload-limit banners DO
    // render in the main body, so keep those text checks.
    const deadline = Date.now() + DIALOG_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const result = await page.evaluate(`
            (() => {
                const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
                const dlg = document.querySelector('ytcp-uploads-dialog');
                const step = dlg ? (dlg.getAttribute('workflow-step') || '') : '';
                if (/accounts\.google\.com|sign in|登录/i.test(location.href + ' ' + text) && !dlg) {
                    return { error: 'auth', message: 'YouTube Studio requires login' };
                }
                if (/daily upload limit|copyright strike|not eligible|上传失败|处理失败/i.test(text)) {
                    return { error: 'upload', message: text.slice(0, 500) };
                }
                // DETAILS is the first editable step; earlier steps (SELECT_FILES)
                // mean the upload is still initializing. Do NOT require a laid-out
                // textbox: YouTube keeps the title/desc boxes at 0×0 for an
                // unpredictable window, but they exist in the DOM and are writable.
                // fillYouTubeDetails locates them by aria-label regardless of rect.
                const textboxes = Array.from(document.querySelectorAll('[contenteditable="true"], textarea, input[type="text"]'));
                if (dlg && (step === 'DETAILS' || (step === '' && textboxes.length >= 1))) {
                    return { ok: true };
                }
                return null;
            })()
        `);
        if (result?.ok) return;
        classifyPlatformFailure(PLATFORM, DOMAIN, result, 'YouTube upload failed');
        await page.wait({ time: POLL_MS / 1000 });
    }
    throwPublishFailure(PUBLISH_ERROR_CODES.uploadFailed, 'YouTube upload details dialog did not appear before timeout');
}

async function fillYouTubeDetails(page, title, description) {
    // The title/description boxes are `<div id="textbox" contenteditable>` and,
    // critically, YouTube lays them out at rect 0×0 for an unpredictable window
    // (sometimes the whole DETAILS step) — yet setNativeText writes to them fine
    // even at 0×0 (verified). So DO NOT gate on isVisible/rect here: locate the
    // title box by its aria-label ("标题"/"title") and the description box by its
    // own label, independent of layout. Poll only until the boxes exist in the DOM.
    const deadline = Date.now() + 30_000;
    let result = null;
    while (Date.now() < deadline) {
        result = await page.evaluateWithArgs(`
            (() => {
                ${visibleElementScript()}
                const boxes = Array.from(document.querySelectorAll('[contenteditable="true"], textarea, input[type="text"]'))
                    .filter((el) => {
                        const label = (el.getAttribute('aria-label') || el.closest('[aria-label]')?.getAttribute('aria-label') || '').toLowerCase();
                        const text = (el.innerText || el.value || '').trim();
                        return !label.includes('search') && text.length < 5000;
                    });
                const labelOf = (el) => (el.getAttribute('aria-label') || el.closest('[aria-label]')?.getAttribute('aria-label') || '').toLowerCase();
                const titleBox = boxes.find((el) => /标题|title/.test(labelOf(el)));
                const descBox = boxes.find((el) => el !== titleBox && /介绍|描述|说明|describe|description|tell viewers/.test(labelOf(el)));
                // Fallback to positional (title first, desc second) if labels ever change.
                const t = titleBox || boxes[0];
                const d = descBox || (boxes[1] && boxes[1] !== t ? boxes[1] : null);
                if (!t) return { pending: true, message: 'YouTube title field not present yet' };
                setNativeText(t, videoTitle);
                if (d && videoDescription) setNativeText(d, videoDescription);
                return { ok: true, matchedTitleByLabel: !!titleBox, matchedDescByLabel: !!descBox };
            })()
        `, { videoTitle: title, videoDescription: description });
        if (result?.ok) {
            debugPublish(`fillYouTubeDetails: ${JSON.stringify(result)}`);
            return;
        }
        await page.wait({ time: 0.6 });
    }
    // Exhausted: surface as the platform error the caller expects.
    classifyPlatformFailure(PLATFORM, DOMAIN, { error: 'platform', message: 'YouTube title field was not found' }, 'YouTube details fill failed');
}


function normalizeBodyText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

const PRIVACY_TEXT = {
    public: ['public', '公开'],
    unlisted: ['unlisted', '不公开列出'],
    private: ['private', '私享', '私密'],
};

function textMentionsPrivacy(text, privacy) {
    const normalized = normalizeBodyText(text).toLowerCase();
    return (PRIVACY_TEXT[privacy] || []).some((label) => normalized.includes(label.toLowerCase()));
}

function textMentionsOtherPrivacy(text, privacy) {
    return Object.keys(PRIVACY_TEXT).some((candidate) => candidate !== privacy && textMentionsPrivacy(text, candidate));
}

export function classifyYouTubePublishState({ text = '', anchors = [], privacy = 'public' } = {}) {
    const bodyText = normalizeBodyText(text);
    if (/sign in|session expired|登录|会话/i.test(bodyText)) {
        return { error: 'auth', message: 'YouTube login expired during publish' };
    }
    if (/failed|error|try again|copyright|policy|restriction|发布失败|上传失败|版权|违规/i.test(bodyText)) {
        return { error: 'platform', message: bodyText.slice(0, 500) };
    }

    const uploadOnly = /upload complete|processing will begin|上传完成|处理将开始/i.test(bodyText);
    const publishDone = /video published|published successfully|video is now public|changes saved|video saved|saved successfully|已发布|保存成功|已保存/i.test(bodyText);
    if (!publishDone) {
        return uploadOnly ? { pending: true, message: 'YouTube upload complete is not a publish success signal' } : null;
    }

    if (textMentionsOtherPrivacy(bodyText, privacy) && !textMentionsPrivacy(bodyText, privacy)) {
        return { error: 'platform', message: `YouTube publish completed with unexpected visibility; expected ${privacy}` };
    }
    return { ok: true, url: anchors[0] || '', message: 'YouTube publish completed' };
}

/**
 * Single probe of the upload dialog's current state. YouTube Studio's
 * `<ytcp-uploads-dialog>` carries a stable `workflow-step` attribute
 * (DETAILS → VIDEO_ELEMENTS → CHECKS → REVIEW → VISIBILITY) that is
 * language-independent, so we drive paging off it instead of reading the
 * Shady-DOM body text (which reads empty). Also reports the Next/Done button
 * presence + disabled state so the pager can distinguish "still processing"
 * from "button missing" in one round-trip.
 */
async function readWorkflowStep(page) {
    return page.evaluate(`
        (() => {
            const dlg = document.querySelector('ytcp-uploads-dialog');
            if (!dlg) return { present: false };
            const state = (id) => {
                const el = dlg.querySelector(id);
                if (!el) return { found: false, disabled: false };
                return { found: true, disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' };
            };
            const next = state('#next-button');
            const done = state('#done-button');
            // The visibility radios (PUBLIC/UNLISTED/PRIVATE) live on the final
            // step — which is the REVIEW step, NOT a separate VISIBILITY step.
            // Their presence, not workflow-step, is the reliable "we can pick
            // privacy now" signal.
            const box = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
            const privacyRadio = dlg.querySelector('[name="PUBLIC"], [name="UNLISTED"], [name="PRIVATE"]');
            // privacyReady means "laid out"; the radio often sits in the DOM at
            // rect 0×0 long before that. Reporting presence separately is what
            // lets the pager tell "YouTube is still processing the final step"
            // apart from "the flow never got there at all".
            const privacyPresent = !!privacyRadio;
            // The dialog is Shady DOM and mostly laid out at 0×0, so innerText
            // reads empty — textContent does not depend on layout, so it is the
            // only route to any processing/progress copy. Diagnostic only: the
            // paging decision below never depends on these fields.
            const dialogText = (dlg.textContent || '').replace(/\s+/g, ' ').trim();
            const pct = dialogText.match(/(\d{1,3})\s*%/);
            const progressEl = dlg.querySelector('[role="progressbar"], ytcp-video-upload-progress, paper-progress');
            return {
                present: true,
                step: dlg.getAttribute('workflow-step') || '',
                nextFound: next.found,
                nextDisabled: next.disabled,
                doneFound: done.found,
                doneDisabled: done.disabled,
                privacyReady: box(privacyRadio),
                privacyPresent,
                progressPct: pct ? Number(pct[1]) : null,
                progressValue: progressEl?.getAttribute('aria-valuenow') || progressEl?.getAttribute('value') || '',
                progressText: dialogText.slice(0, 200),
            };
        })()
    `);
}

/**
 * Select a radio by stable `name` attribute (e.g. VIDEO_MADE_FOR_KIDS_NOT_MFK,
 * PUBLIC/UNLISTED/PRIVATE) with the human label as a fallback, then read back
 * aria-checked to confirm the click landed. Radios are `tp-yt-paper-radio-button`,
 * which `clickByLabels` does not scan, so the name-anchored click lives here.
 */
async function clickAndVerifyYouTubeRadio(page, { nameSelectors = [], labels = [], settingName, required = true } = {}) {
    const result = await page.evaluateWithArgs(`
        (() => {
            ${visibleElementScript()}
            function isChecked(el) {
                return el.checked === true
                    || el.getAttribute('aria-checked') === 'true'
                    || el.getAttribute('checked') === 'true'
                    || el.hasAttribute('checked')
                    || el.classList?.contains('iron-selected')
                    || el.classList?.contains('checked');
            }
            // Pass 0: stable name attribute — survives UI copy / i18n changes.
            // Do NOT gate on isVisible: YouTube's Polymer radios (made-for-kids,
            // privacy) are laid out at rect 0×0 for a while after the step loads
            // but are fully clickable — a name hit IS the target, so trust it.
            for (const sel of nameSelectors) {
                const el = document.querySelector(sel);
                if (el) {
                    el.click();
                    return { ok: true, via: 'attr', sel, checked: isChecked(el) };
                }
            }
            // Pass 1: human-label substring fallback (legacy behavior).
            const wanted = labels.map((label) => String(label).toLowerCase());
            const candidates = Array.from(document.querySelectorAll('tp-yt-paper-radio-button, ytcp-radio-button, [role="radio"], label'));
            for (const el of candidates) {
                const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
                if (!text || text.length > 240 || !isVisible(el)) continue;
                if (wanted.some((label) => text.includes(label))) {
                    el.click();
                    return { ok: true, via: 'text', text, checked: isChecked(el) };
                }
            }
            return { ok: false, message: settingName + ' radio was not found' };
        })()
    `, { nameSelectors, labels, settingName });
    if (!result?.ok) {
        if (!required && /radio was not found/i.test(result?.message || '')) {
            return { ok: false, skipped: true, message: result?.message || `YouTube ${settingName} radio was not found` };
        }
        throwPublishFailure(PUBLISH_ERROR_CODES.platformError, result?.message || `YouTube ${settingName} radio was not found`);
    }

    await page.wait({ time: 0.3 });
    const verified = await page.evaluateWithArgs(`
        (() => {
            function radioSelected(el) {
                const nodes = [el, el.closest?.('[role="radio"]'), el.querySelector?.('[role="radio"]'), el.querySelector?.('input[type="radio"]')].filter(Boolean);
                return nodes.some((node) => node.checked === true
                    || node.getAttribute?.('aria-checked') === 'true'
                    || node.getAttribute?.('checked') === 'true'
                    || node.hasAttribute?.('checked')
                    || node.classList?.contains('iron-selected')
                    || node.classList?.contains('checked'));
            }
            // Confirm by name attribute first — the reliable read-back.
            for (const sel of nameSelectors) {
                const el = document.querySelector(sel);
                if (el && radioSelected(el)) return { ok: true, via: 'attr', sel };
            }
            // Fall back to human-label match.
            const wanted = labels.map((label) => String(label).toLowerCase());
            const candidates = Array.from(document.querySelectorAll('tp-yt-paper-radio-button, ytcp-radio-button, [role="radio"], label'));
            for (const el of candidates) {
                const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
                if (!text || text.length > 240) continue;
                if (wanted.some((label) => text.includes(label)) && radioSelected(el)) {
                    return { ok: true, via: 'text', text };
                }
            }
            return { ok: false, message: settingName + ' radio selection could not be confirmed after click' };
        })()
    `, { nameSelectors, labels, settingName });
    if (!verified?.ok) {
        throwPublishFailure(PUBLISH_ERROR_CODES.platformError, verified?.message || `YouTube ${settingName} radio selection could not be confirmed`);
    }
    return verified;
}

async function chooseNotMadeForKids(page, madeForKids) {
    // Anchor on the stable radio `name` (language-independent); keep human labels
    // as fallback. The made-for-kids answer is MANDATORY — an unselected radio
    // keeps #next-button disabled (0×0), so the whole flow stalls on DETAILS.
    // The radio mounts a beat after the DETAILS step loads and sits at rect 0×0,
    // so poll for it to exist in the DOM (clickAndVerifyYouTubeRadio no longer
    // gates the name hit on visibility).
    const nameSelectors = madeForKids
        ? ['[name="VIDEO_MADE_FOR_KIDS_MFK"]']
        : ['[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]'];
    const labels = madeForKids
        ? ['Yes, it\'s made for kids', '是，内容是面向儿童的', '是，为儿童打造']
        : ['No, it\'s not made for kids', 'No, it is not made for kids', '不，内容不是面向儿童的', '不是，不是为儿童打造'];

    const deadline = Date.now() + 15_000;
    let sawExpand = false;
    while (Date.now() < deadline) {
        const present = await page.evaluateWithArgs(
            `(() => nameSelectors.some((s) => !!document.querySelector(s)))()`,
            { nameSelectors },
        );
        debugPublish(`chooseNotMadeForKids: radio present=${present}`);
        if (present) {
            const selected = await clickAndVerifyYouTubeRadio(page, { nameSelectors, labels, settingName: 'made-for-kids', required: false });
            debugPublish(`chooseNotMadeForKids: select result=${JSON.stringify(selected)}`);
            if (selected?.ok) return selected;
        }
        // YouTube's Shorts flow can hide the audience radio behind "Show more".
        // Try expanding once, then keep polling for the radio to appear.
        if (!sawExpand) {
            await page.evaluate(`
                (() => {
                    ${visibleElementScript()}
                    return clickByLabels(['Show more', 'More options', '显示更多', '展开更多', '更多选项']);
                })()
            `);
            sawExpand = true;
        }
        await page.wait({ time: 0.6 });
    }
    // Radio never appeared (genuine Shorts flow without an audience step): let the
    // caller proceed; if it was actually required, the next-button will stay
    // disabled and advanceToPrivacyStep reports the stall.
    return { ok: false, skipped: true, message: 'made-for-kids radio did not appear' };
}

// Budget for advancing DETAILS → the privacy step. YouTube keeps the Continue
// button disabled while it processes the upload on the REVIEW step (observed
// 80s+ on a small clip), so the pager must wait, not fail.
const MIN_NEXT_BUDGET_MS = 60_000;
const DEFAULT_NEXT_BUDGET_MS = 240_000;
// Tail reserve carved out of --timeout for the steps that follow this one:
// clickPublish (30s) + PUBLISH_TIMEOUT_MS (120s), plus 10s of slack. Keep this
// in sync if either of those budgets changes.
const TAIL_RESERVE_MS = 160_000;
// Budget for merely REACHING the REVIEW step. Stalling before REVIEW means the
// flow is stuck upstream (e.g. an unanswered made-for-kids radio keeps
// #next-button permanently disabled) — waiting out a large --timeout there just
// delays the same failure, so fail fast and say where it stalled.
const REACH_REVIEW_BUDGET_MS = 90_000;

/**
 * Resolve the budget for advanceToPrivacyStep.
 *
 * Precedence: explicit env override > the slice of --timeout still unspent >
 * the 240s default. NEXT_BUDGET_MS used to be a module constant that only read
 * the env var, so `--timeout 840` had no effect on the inner wait and the pager
 * always gave up at 240s while the runtime ceiling still had minutes to spare.
 *
 * Deriving from --timeout keeps the inner budget strictly below the outer
 * runtime ceiling (timeout + RUNTIME_TIMEOUT_PADDING_SECONDS, see
 * src/execution.ts), so an exhausted budget surfaces this adapter's diagnostic
 * failure instead of the runtime's generic TimeoutError, which carries no DOM state.
 */
export function computeNextBudgetMs({ timeoutSec, elapsedMs = 0 } = {}) {
    const envRaw = Number(process.env.OPENCLI_YOUTUBE_NEXT_TIMEOUT_MS);
    if (Number.isFinite(envRaw) && envRaw > 0) return Math.max(MIN_NEXT_BUDGET_MS, envRaw);
    const timeoutMs = Number(timeoutSec) > 0 ? Number(timeoutSec) * 1000 : 0;
    if (!timeoutMs) return DEFAULT_NEXT_BUDGET_MS;
    return Math.max(MIN_NEXT_BUDGET_MS, timeoutMs - elapsedMs - TAIL_RESERVE_MS);
}

/**
 * Advance the upload dialog by clicking #next-button until the visibility radios
 * (PUBLIC/UNLISTED/PRIVATE) appear. IMPORTANT: those radios live on the REVIEW
 * step — there is NO separate "VISIBILITY" workflow-step in the normal video
 * flow — so we page on radio *presence*, not on the workflow-step value. The
 * REVIEW step also keeps Continue disabled while processing (checks show
 * "上传完毕 / 检查完毕" yet the button stays 0×0), which is expected: wait it out.
 *
 * Two budgets: REACH_REVIEW_BUDGET_MS to reach REVIEW at all (a stall before it
 * is an upstream bug, not processing, so fail fast), then the full budgetMs once
 * REVIEW is confirmed. reachReviewMs is injectable so tests need not burn 90s.
 */
async function advanceToPrivacyStep(page, {
    budgetMs = DEFAULT_NEXT_BUDGET_MS,
    reachReviewMs = REACH_REVIEW_BUDGET_MS,
    privacyRadio = null,
} = {}) {
    const startedAt = Date.now();
    const reachReviewDeadline = startedAt + reachReviewMs;
    const processingDeadline = startedAt + budgetMs;
    // Two tiers, mirroring clickTikTokPublish's sawDisabled pattern: a tight
    // budget to reach REVIEW at all, then the full budget once the final step is
    // confirmed and the wait is genuinely YouTube-side processing.
    let sawReview = false;
    let lastStep = '';
    let lastProbe = null;
    let ticks = 0;
    while (true) {
        // min() so a small --timeout is never inflated by the reach-REVIEW floor.
        const deadline = sawReview ? processingDeadline : Math.min(reachReviewDeadline, processingDeadline);
        if (Date.now() >= deadline) break;

        const probe = await readWorkflowStep(page);
        if (!probe?.present) {
            throwPublishFailure(PUBLISH_ERROR_CODES.platformError, 'YouTube upload dialog closed before the visibility step was reached');
        }
        lastProbe = probe;
        lastStep = probe.step || lastStep;
        // REVIEW, or a privacy radio already mounted (even at 0×0), both mean
        // the final step is up and the remaining wait is server-side processing.
        if (probe.step === 'REVIEW' || probe.privacyPresent) sawReview = true;
        // Reached the final step: the privacy radios are on screen.
        if (probe.privacyReady) return probe;

        // Log sparsely (every ~10 ticks) so the tail shows where it's stuck.
        if (ticks % 10 === 0) {
            debugPublish(`advanceToPrivacyStep: step=${probe.step} nextFound=${probe.nextFound} nextDisabled=${probe.nextDisabled} privacyPresent=${probe.privacyPresent} privacyReady=${probe.privacyReady} progress=${probe.progressPct ?? probe.progressValue ?? ''} t=${Math.round((Date.now() - startedAt) / 1000)}s`);
        }
        ticks += 1;

        // Advance by clicking #next-button DIRECTLY (not via clickByLabels): its
        // attrSelector path filters on isVisible, and YouTube lays #next-button
        // out at rect 0×0 on DETAILS even when it is enabled and fully clickable,
        // so clickByLabels reports "button not found" and the flow never leaves
        // DETAILS. A raw querySelector().click() works at 0×0 (verified). Only
        // click when it exists and is not disabled — a disabled Continue on the
        // final (REVIEW) processing screen is a "wait", not a click target.
        const clicked = await page.evaluate(`
            (() => {
                const n = document.querySelector('ytcp-uploads-dialog #next-button');
                if (!n) return { ok: false, reason: 'no-next' };
                if (n.hasAttribute('disabled') || n.getAttribute('aria-disabled') === 'true') return { ok: false, reason: 'disabled' };
                n.click();
                return { ok: true };
            })()
        `);
        if (ticks % 10 === 1) debugPublish(`advanceToPrivacyStep: click result=${JSON.stringify(clicked)}`);
        await page.wait({ time: 1.2 });
    }
    // Last resort before giving up: the radio is in the DOM and only the layout
    // is missing. clickAndVerifyYouTubeRadio's attr pass ignores rect and reads
    // aria-checked back, so a failure here cannot produce a false "selected" —
    // an unconfirmed click just falls through to the timeout below.
    if (privacyRadio && lastProbe?.privacyPresent && !lastProbe?.privacyReady) {
        const rescued = await clickAndVerifyYouTubeRadio(page, { ...privacyRadio, required: false }).catch(() => null);
        if (rescued?.ok) {
            debugPublish(`advanceToPrivacyStep: rescued a rect-0 privacy radio after ${Math.round((Date.now() - startedAt) / 1000)}s`);
            return { ...lastProbe, privacyRescued: true };
        }
    }

    const waitedS = Math.round((Date.now() - startedAt) / 1000);
    const screenshotPath = '/tmp/youtube_visibility_debug.png';
    try { await page.screenshot({ path: screenshotPath }); } catch { /* screenshot is best-effort */ }
    const state = JSON.stringify({
        step: lastStep || 'unknown',
        nextFound: Boolean(lastProbe?.nextFound),
        nextDisabled: Boolean(lastProbe?.nextDisabled),
        doneFound: Boolean(lastProbe?.doneFound),
        privacyPresent: Boolean(lastProbe?.privacyPresent),
        privacyReady: Boolean(lastProbe?.privacyReady),
        progress: lastProbe?.progressPct ?? lastProbe?.progressValue ?? '',
        sawReview,
    });
    // Point at the lever that actually applies: raising the timeout only helps
    // when the wait really is REVIEW-step processing.
    const hint = sawReview
        ? 'the video is likely still processing — raise --timeout (or OPENCLI_YOUTUBE_NEXT_TIMEOUT_MS) to wait longer'
        : 'the dialog never reached the REVIEW step — check the details / made-for-kids step rather than raising the timeout';
    throwPublishFailure(
        PUBLISH_ERROR_CODES.platformError,
        `YouTube visibility options did not appear after ${waitedS}s (last state: ${state}); ${hint}; screenshot: ${screenshotPath}`,
    );
}

async function goThroughChecks(page, privacy, { budgetMs = DEFAULT_NEXT_BUDGET_MS, reachReviewMs } = {}) {
    await chooseNotMadeForKids(page, false);

    const nameSelectors = privacy === 'private'
        ? ['[name="PRIVATE"]']
        : privacy === 'unlisted'
            ? ['[name="UNLISTED"]']
            : ['[name="PUBLIC"]'];
    const labels = privacy === 'private'
        ? ['Private', '私享', '私密']
        : privacy === 'unlisted'
            ? ['Unlisted', '不公开列出']
            : ['Public', '公开'];

    const privacyRadio = { nameSelectors, labels, settingName: 'privacy' };
    const reached = await advanceToPrivacyStep(page, { budgetMs, reachReviewMs, privacyRadio });
    // The rescue path already clicked and verified the radio; re-clicking would
    // toggle nothing but wastes a round-trip, so skip it.
    if (reached?.privacyRescued) return;
    await clickAndVerifyYouTubeRadio(page, { ...privacyRadio, required: true });
}

async function clickPublish(page) {
    // Click #done-button DIRECTLY (like #next-button): clickByLabels' visibility
    // filter can drop a rect-0 button. #done-button is disabled until the privacy
    // choice registers (and re-disables during any final processing), so poll
    // until it is present-and-enabled, then click regardless of layout.
    const deadline = Date.now() + 30_000;
    let last = null;
    while (Date.now() < deadline) {
        const clicked = await page.evaluate(`
            (() => {
                const d = document.querySelector('ytcp-uploads-dialog #done-button');
                if (!d) return { ok: false, reason: 'no-done' };
                if (d.hasAttribute('disabled') || d.getAttribute('aria-disabled') === 'true') return { ok: false, reason: 'disabled' };
                d.click();
                return { ok: true };
            })()
        `);
        last = clicked;
        if (clicked?.ok) { debugPublish('clickPublish: clicked #done-button'); return; }
        await page.wait({ time: 0.8 });
    }
    debugPublish(`clickPublish: gave up, last=${JSON.stringify(last)}`);
    throwPublishFailure(PUBLISH_ERROR_CODES.platformError, `YouTube publish/save button (#done-button) was not clickable (${last?.reason || 'unknown'})`);
}

async function waitForYouTubePublishResult(page, privacy) {
    const deadline = Date.now() + PUBLISH_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const result = await page.evaluateWithArgs(`
            (() => {
                const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
                const anchors = Array.from(document.querySelectorAll('a[href*="watch?v="], a[href*="youtu.be/"]')).map((a) => a.href).filter(Boolean);
                return { text, anchors, privacy };
            })()
        `, { privacy });
        const state = classifyYouTubePublishState(result);
        if (state?.ok) return state;
        classifyPlatformFailure(PLATFORM, DOMAIN, state, 'YouTube publish failed');
        await page.wait({ time: POLL_MS / 1000 });
    }
    throwPublishFailure(PUBLISH_ERROR_CODES.platformError, 'YouTube publish/save clicked but final publish state was not confirmed before timeout; check YouTube Studio manually.');
}

export const publishCommand = cli({
    site: 'youtube',
    name: 'publish',
    access: 'write',
    description: 'Upload and publish a local video to YouTube Studio and return a structured result',
    domain: DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: STUDIO_URL,
    args: [
        { name: 'video', required: true, positional: true, help: 'Local video file path (mp4/mov/m4v/webm)' },
        { name: 'title', required: true, help: 'Video title' },
        { name: 'description', default: '', help: 'Video description' },
        { name: 'tags', default: '', help: 'Comma-separated tags; written as hashtags in the description' },
        { name: 'cover', default: '', help: 'Thumbnail image path (currently returns unsupported_capability)' },
        { name: 'schedule', default: '', help: 'Scheduled publish time (currently returns unsupported_capability)' },
        { name: 'privacy', default: 'public', choices: ['public', 'unlisted', 'private'], help: 'YouTube visibility' },
        { name: 'account', default: '', help: 'Channel/account selector (currently returns unsupported_capability)' },
        { name: 'draft', type: 'bool', default: false, help: 'Save as draft (currently returns unsupported_capability)' },
        { name: 'timeout', type: 'int', default: 600, help: 'Max seconds for the overall command; the wait for YouTube-side processing (the REVIEW step, before the visibility options unlock) is budgeted from whatever is left of this, so raising it genuinely waits longer (default: 600)' },
    ],
    columns: ['ok', 'platform', 'status', 'code', 'capability', 'message', 'url', 'draft'],
    func: async (page, kwargs) => {
        const startedAt = Date.now();
        const input = validateVideoPublishInput(kwargs, PLATFORM, {
            maxTitleLength: 100,
            maxDescriptionLength: 5000,
            validateCover: false,
        });
        const unsupported = unsupportedForInput(input);
        if (unsupported) return unsupported;

        await requireBrowserUploadSupport(page, PLATFORM);
        await page.goto(STUDIO_URL, { waitUntil: 'load', settleMs: 4000 });
        await assertYouTubeLoggedIn(page);
        await openUploadDialog(page);
        await setFileInput(page, [input.videoPath], FILE_SELECTORS, PLATFORM);
        await waitForDetailsDialog(page);

        const description = buildDescriptionWithTags(input.description, input.tags);
        await fillYouTubeDetails(page, input.title, description);
        // Charge the wait for YouTube-side processing against what is left of
        // --timeout, not a fixed constant, so raising --timeout actually waits longer.
        await goThroughChecks(page, input.privacy, {
            budgetMs: computeNextBudgetMs({ timeoutSec: kwargs.timeout, elapsedMs: Date.now() - startedAt }),
        });
        await clickPublish(page);
        const publishResult = await waitForYouTubePublishResult(page, input.privacy);

        return successResult(PLATFORM, publishResult.message || 'YouTube publish completed', {
            url: publishResult.url || '',
            draft: false,
        });
    },
});

export const __test__ = {
    unsupportedForInput,
    computeNextBudgetMs,
    fillYouTubeDetails,
    readWorkflowStep,
    chooseNotMadeForKids,
    advanceToPrivacyStep,
    goThroughChecks,
    clickAndVerifyYouTubeRadio,
    classifyYouTubePublishState,
    waitForYouTubePublishResult,
};
