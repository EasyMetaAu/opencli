// TikTok Studio API publish — in-page fetch replay of the internal publish endpoints.
//
// Unlike the DOM path (calendar/timepicker/publish-button clicks), this drives the
// same internal JSON endpoints that tiktokstudio/upload's own frontend calls. Every
// request runs inside the logged-in page via page.evaluate, so the page SDK auto-signs
// it (X-Bogus / X-Gnarly / msToken) — we never compute a signature ourselves.
//
// Endpoint sequence (verified end-to-end 2026-07-03):
//   1. video bytes uploaded via CDP setFileInput (page SDK → TOS CDN)  — done by caller
//   2. capture vid from the TOS upload RESPONSE via CDP network capture — extractVidFromCapture()
//      (vid is NOT in the Redux store; the SDK clears it after upload — must sniff the wire)
//   3. POST /tiktok/web/project/post/v1/ {schedule_time,text,video_id} — projectPost()
//      (content/check/create is optional; publish succeeds without it and without cover_info)
//
// schedule_time is a Unix SECOND timestamp (0 / omitted => publish now), exactly like
// douyin's create_v2 `timing`. No wall-clock math, no picker.
//
// TOS upload response shape (from tos19-up-*.tiktokcdn-us.com/upload/v1/...):
//   {code:2000, data:{post_upload_resp:{results:[{vid:"v1202...", video_meta:{Width,Height,Duration,...}}]}}}

import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

const POST_API_PATH = '/tiktok/web/project/post/v1/';
const CONTENT_CHECK_PATH = '/tiktok/v1/creator/content/check/create';

// Common query params observed on the live requests. aid=1988 is the TikTok web app id.
const POST_QUERY = 'app_name=tiktok_web&channel=tiktok_web&device_platform=web&aid=1988';
const CHECK_QUERY = 'aid=1988';

// visibility mapping — matches douyin's public/friends/private → 0/1/2.
// NOTE: only visibility_type=0 (public) is captured/verified; 1/2 inferred, needs a live check.
const VISIBILITY_TYPE = { public: 0, friends: 1, private: 2 };

/**
 * Run a fetch() inside the logged-in page so the page SDK auto-signs it.
 * Returns the parsed JSON (page-context), or a sentinel object on transport error.
 * Mirrors douyin/_shared/browser-fetch.js but tuned for TikTok's status envelope.
 */
async function pageFetchJson(page, method, path, body) {
    const js = `
    (async () => {
      try {
        const res = await fetch(${JSON.stringify(path)}, {
          method: ${JSON.stringify(method)},
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          ${body !== undefined ? `body: JSON.stringify(${JSON.stringify(body)}),` : ''}
        });
        const text = await res.text();
        try { return { __http: res.status, __json: JSON.parse(text) }; }
        catch { return { __http: res.status, __text: text.slice(0, 500) }; }
      } catch (e) { return { __neterr: String(e && e.message || e) }; }
    })()
  `;
    let result;
    try {
        result = await page.evaluate(js);
    } catch (error) {
        throw new CommandExecutionError(`TikTok API request failed (${method} ${path}): ${error instanceof Error ? error.message : String(error)}`);
    }
    // unwrap Browser Bridge {session,data} envelope if present
    if (result && typeof result === 'object' && 'session' in result && 'data' in result) {
        result = result.data;
    }
    if (!result || typeof result !== 'object') {
        throw new CommandExecutionError(`TikTok API returned malformed payload (${method} ${path}): ${JSON.stringify(result)}`);
    }
    if (result.__neterr) {
        throw new CommandExecutionError(`TikTok API network error (${method} ${path}): ${result.__neterr}`);
    }
    if (result.__text !== undefined) {
        throw new CommandExecutionError(`TikTok API non-JSON response (${method} ${path}) HTTP ${result.__http}: ${result.__text}`);
    }
    const json = result.__json;
    const code = json?.status_code;
    if (code !== undefined && code !== 0) {
        const msg = json?.status_msg || 'unknown error';
        if (code === 401 || code === 403 || /login|cookie|auth|captcha|verify|forbidden|permission|登录|登陆|权限|验证/i.test(String(msg))) {
            throw new AuthRequiredError(DOMAIN_FOR_AUTH, `TikTok API auth/permission error ${code} (${method} ${path}): ${msg}`);
        }
        throw new CommandExecutionError(`TikTok API error ${code} (${method} ${path}): ${msg}`);
    }
    return json;
}

const DOMAIN_FOR_AUTH = 'www.tiktok.com';

// creation_id observed on live posts looks like a 21-char url-safe token (e.g.
// "wFdSoyO6UKyPz4wg8_Ndw"). Any unique url-safe string is accepted by the API.
const CREATION_ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
export function generateCreationId() {
    let s = '';
    for (let i = 0; i < 21; i += 1) s += CREATION_ID_CHARS[Math.floor(Math.random() * CREATION_ID_CHARS.length)];
    return s;
}

// URL substring identifying the TOS upload requests whose response carries the vid.
export const TOS_CAPTURE_PATTERN = 'tiktokcdn-us.com/upload/v1/';

// Page-side hook: wrap fetch + XMLHttpRequest so the TOS upload "finish" response (which
// carries post_upload_resp.results[0].vid) is stashed on window.__ttUploadVid the moment
// it returns. We do this in-page rather than via CDP Network capture because CDP's
// getResponseBody frequently fails on the TOS finish response ("No resource with given
// identifier") — the body is gone by the time loadingFinished fires. The page hook reads
// the body synchronously in the SDK's own response handler, so it never misses it.
// Idempotent; safe to install repeatedly.
function installVidHookScript() {
    return `
    (() => {
      try {
        if (window.__ttVidHookInstalled) return { already: true };
        window.__ttUploadVid = window.__ttUploadVid || null;
        const grab = (text) => {
          if (!text || text.indexOf('post_upload_resp') === -1) return;
          try {
            const j = JSON.parse(text);
            const r = j && j.data && j.data.post_upload_resp && j.data.post_upload_resp.results && j.data.post_upload_resp.results[0];
            if (r && r.vid) {
              window.__ttUploadVid = { video_id: r.vid,
                width: (r.video_meta && r.video_meta.Width) || 0,
                height: (r.video_meta && r.video_meta.Height) || 0,
                duration: (r.video_meta && r.video_meta.Duration) || 0 };
            }
          } catch (e) {}
        };
        const isTos = (u) => typeof u === 'string' && u.indexOf('/upload/v1/tos-') !== -1;
        // fetch
        const of = window.fetch;
        if (of) {
          window.fetch = function (...a) {
            const u = (a[0] && a[0].url) || String(a[0] || '');
            return of.apply(this, a).then((res) => {
              if (isTos(u)) { try { res.clone().text().then(grab).catch(() => {}); } catch (e) {} }
              return res;
            });
          };
        }
        // XMLHttpRequest (webmssdk uploader uses XHR)
        const OX = window.XMLHttpRequest;
        if (OX) {
          const oOpen = OX.prototype.open;
          const oSend = OX.prototype.send;
          OX.prototype.open = function (method, url) { this.__ttUrl = url; return oOpen.apply(this, arguments); };
          OX.prototype.send = function () {
            this.addEventListener('load', function () {
              try { if (isTos(this.__ttUrl)) grab(this.responseText); } catch (e) {}
            });
            return oSend.apply(this, arguments);
          };
        }
        window.__ttVidHookInstalled = true;
        return { installed: true };
      } catch (e) { return { err: String(e && e.message || e) }; }
    })()
  `;
}

/** Install the page-side vid hook. Call BEFORE the upload is triggered. */
export async function installVidHook(page) {
    let r = await page.evaluate(installVidHookScript());
    if (r && typeof r === 'object' && 'session' in r && 'data' in r) r = r.data;
    return r;
}

/** Read the vid captured by the page hook, or null. */
async function readCapturedVid(page) {
    let r = await page.evaluate('window.__ttUploadVid || null');
    if (r && typeof r === 'object' && 'session' in r && 'data' in r) r = r.data;
    return r && r.video_id ? r : null;
}

/** Build the TikTok-specific text_extra + markup_text from caption + hashtags.
 * TikTok shape differs from douyin: {tag_id,start,end,user_id,type,hashtag_name}
 * plus a markup_text where each tag is wrapped as <h id="N">#name</h>.
 */
function buildTextExtra(text) {
    const extra = [];
    let markup = '';
    let last = 0;
    let idx = 0;
    const re = /#([^\s#]+)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const start = m.index;
        const end = m.index + m[0].length;
        markup += text.slice(last, start);
        markup += `<h id="${idx}">${m[0]}</h>`;
        extra.push({
            tag_id: String(idx),
            start,
            end,
            user_id: '',
            type: 1,
            hashtag_name: m[1],
        });
        last = end;
        idx += 1;
    }
    markup += text.slice(last);
    return { text_extra: extra, markup_text: markup };
}

/**
 * Build the /tiktok/web/project/post/v1/ request body.
 * @param {object} p
 * @param {string} p.creationId
 * @param {string} p.videoId
 * @param {string} p.text        caption (with #hashtags inline)
 * @param {number} p.scheduleTime Unix seconds, or 0 for publish-now
 * @param {string} p.privacy     'public' | 'friends' | 'private'
 */
export function buildProjectPostBody({ creationId, videoId, text, scheduleTime = 0, privacy = 'public' }) {
    const { text_extra, markup_text } = buildTextExtra(text);
    const featureCommon = {
        geofencing_regions: [],
        playlist_name: '',
        playlist_id: '',
        tcm_params: '{"commerce_toggle_info":{}}',
        sound_exemption: 0,
        anchors: [],
        vedit_common_info: { draft: '', video_id: videoId },
        privacy_setting_info: {
            visibility_type: VISIBILITY_TYPE[privacy] ?? 0,
            allow_duet: 0,
            allow_stitch: 0,
            allow_comment: 1,
            allow_content_reuse: 0,
            allow_ai_remix: 2,
        },
        content_check_id: '',
    };
    if (scheduleTime && scheduleTime > 0) {
        featureCommon.schedule_time = scheduleTime;
    }
    return {
        post_common_info: {
            creation_id: creationId,
            enter_post_page_from: 2,
            post_type: 3,
        },
        feature_common_info_list: [featureCommon],
        single_post_req_list: [{
            batch_index: 0,
            video_id: videoId,
            is_long_video: 1,
            single_post_feature_info: {
                text,
                text_extra,
                markup_text,
                music_info: { origin_volume: '100' },
                // ⚠️ cover_info OMITTED: live sample carried a large coverProject JSON from
                // the cover-editor SDK. Whether the post succeeds without it is UNVERIFIED
                // and must be confirmed with one live publish. If required, populate a
                // minimal first-frame cover here.
            },
        }],
    };
}

/** Optional content safety pre-check. Returns check_id map (may be empty). */
export async function contentCheck(page, videoId) {
    const json = await pageFetchJson(page, 'POST', `${CONTENT_CHECK_PATH}?${CHECK_QUERY}`, { video_id: videoId, tasks: [0] });
    return json?.check_ids ?? {};
}

/**
 * POST the publish request. Returns { item_id, project_id }.
 */
export async function projectPost(page, body) {
    const json = await pageFetchJson(page, 'POST', `${POST_API_PATH}?${POST_QUERY}`, body);
    const resp = json?.single_post_resp_list?.[0];
    const itemId = resp?.item_id;
    if (!itemId) {
        throw new CommandExecutionError(`TikTok publish returned no item_id: ${JSON.stringify(json).slice(0, 400)}`);
    }
    if (resp.status_code !== undefined && resp.status_code !== 0) {
        throw new CommandExecutionError(`TikTok publish per-item error ${resp.status_code}: ${resp.status_msg || ''}`);
    }
    return { item_id: itemId, project_id: json?.project_id ?? '' };
}

/**
 * Poll the page-side vid hook until the TOS upload "finish" response is seen.
 * Requires installVidHook(page) to have been called BEFORE the upload was triggered.
 * Returns { video_id, width, height, duration }.
 */
export async function waitForVideoId(page, { timeoutMs = 180_000, pollMs = 1500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const info = await readCapturedVid(page).catch(() => null);
        if (info && info.video_id) return info;
        await page.wait({ time: pollMs / 1000 });
    }
    throw new CommandExecutionError('TikTok upload did not yield a video_id (no TOS finish response seen before timeout)');
}

export const __test__ = { buildTextExtra, VISIBILITY_TYPE };
