import { cli, Strategy } from '@jackwener/opencli/registry';
import {
    ArgumentError,
    CommandExecutionError,
    EmptyResultError,
    getErrorMessage,
} from '@jackwener/opencli/errors';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 120;
const SERVER_PAGE_MAX = 30;
const MAX_PAGES = 4;

function normalizeUsername(value) {
    const username = String(value ?? '').trim().replace(/^@+/, '');
    if (!username) {
        throw new ArgumentError('username is required', 'Example: opencli tiktok user dictogo --limit 20');
    }
    if (!/^[A-Za-z0-9._-]+$/.test(username)) {
        throw new ArgumentError('username contains unsupported characters', 'Pass the TikTok handle without @, for example: dictogo');
    }
    return username;
}

function requireLimit(value) {
    const raw = value ?? DEFAULT_LIMIT;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new ArgumentError('limit must be a positive integer', `Example: opencli tiktok user dictogo --limit ${DEFAULT_LIMIT}`);
    }
    if (parsed > MAX_LIMIT) {
        throw new ArgumentError(`limit must be <= ${MAX_LIMIT}`, `Example: opencli tiktok user dictogo --limit ${MAX_LIMIT}`);
    }
    return parsed;
}

function buildUserVideosScript(username, limit) {
    return `
(async () => {
  const username = ${JSON.stringify(username)};
  const limit = ${Number(limit)};
  const maxPages = ${MAX_PAGES};
  const pageSize = Math.min(${SERVER_PAGE_MAX}, Math.max(1, limit));

  function asNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function cleanText(value, maxLength) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
  }

  function getCookie(name) {
    const prefix = name + '=';
    for (const part of document.cookie.split('; ')) {
      if (part.startsWith(prefix)) return decodeURIComponent(part.slice(prefix.length));
    }
    return '';
  }


  function findUniversalData() {
    const scripts = Array.from(document.querySelectorAll('script'));
    for (const script of scripts) {
      const text = script.textContent || '';
      if (!text.includes('webapp.user-detail') && !text.includes('ItemModule') && !text.includes('itemList')) continue;
      try {
        return JSON.parse(text);
      } catch {
        // Continue scanning; TikTok keeps several JSON-like script tags.
      }
    }
    return null;
  }

  function findUserInfo(root) {
    const stack = [root];
    const seen = new Set();
    while (stack.length) {
      const current = stack.pop();
      if (!current || typeof current !== 'object' || seen.has(current)) continue;
      seen.add(current);
      const user = current.userInfo?.user || current.user;
      if (user && typeof user === 'object') {
        const uniqueId = String(user.uniqueId || user.unique_id || '').toLowerCase();
        if (uniqueId === username.toLowerCase() && user.secUid) return user;
      }
      for (const value of Object.values(current)) {
        if (value && typeof value === 'object') stack.push(value);
      }
    }
    return null;
  }

  function normalizeItem(item, indexHint) {
    if (!item || typeof item !== 'object') return null;
    const id = String(item.id || item.item_id || item.video_id || '').trim();
    if (!id) return null;
    const author = item.author || item.authorInfo || {};
    const authorName = String(author.uniqueId || author.unique_id || item.author_unique_id || username).replace(/^@+/, '');
    const stats = item.stats || item.statistics || item.statsV2 || {};
    const video = item.video || item.videoInfo || {};
    const cover = video.cover || video.originCover || video.dynamicCover || video.coverUrl || item.cover || item.cover_url || '';
    const desc = cleanText(item.desc || item.title || item.description, 500);
    const createTime = asNumber(item.createTime || item.create_time || item.create_time_sec || item.post_time);
    return {
      index: indexHint,
      id,
      url: 'https://www.tiktok.com/@' + encodeURIComponent(authorName || username) + '/video/' + encodeURIComponent(id),
      cover: String(cover || ''),
      title: desc,
      desc,
      plays: asNumber(stats.playCount ?? stats.play_count ?? stats.viewCount ?? stats.view_count),
      likes: asNumber(stats.diggCount ?? stats.digg_count ?? stats.likeCount ?? stats.like_count),
      comments: asNumber(stats.commentCount ?? stats.comment_count),
      shares: asNumber(stats.shareCount ?? stats.share_count),
      createTime,
    };
  }

  function collectUniversalItems(root, secUid) {
    const rows = [];
    const stack = [root];
    const seen = new Set();
    const wanted = username.toLowerCase();
    while (stack.length) {
      const current = stack.pop();
      if (!current || typeof current !== 'object' || seen.has(current)) continue;
      seen.add(current);
      if (Array.isArray(current)) {
        for (const item of current) stack.push(item);
        continue;
      }
      const item = current.itemStruct || current.item || current;
      const author = item.author || {};
      const authorName = String(author.uniqueId || author.unique_id || item.author_unique_id || '').toLowerCase();
      const authorSecUid = String(author.secUid || author.sec_uid || '').trim();
      if ((item.id || item.item_id) && (authorName === wanted || (secUid && authorSecUid === secUid))) {
        rows.push(item);
      }
      for (const value of Object.values(current)) {
        if (value && typeof value === 'object') stack.push(value);
      }
    }
    return rows;
  }

  async function fetchJson(url) {
    const requestUrl = new URL(url, 'https://www.tiktok.com').toString();
    const res = await fetch(requestUrl, { credentials: 'include', headers: { accept: 'application/json,text/plain,*/*' } });
    const text = await res.text();
    let data = null;
    if (text.trim()) {
      try {
        data = JSON.parse(text);
      } catch (error) {
        throw new Error('invalid JSON from ' + requestUrl + ': ' + (error instanceof Error ? error.message : String(error)));
      }
    }
    if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + requestUrl + ': ' + text.slice(0, 160));
    return data || {};
  }

  const universal = findUniversalData();
  let secUid = '';
  const userInfo = findUserInfo(universal);
  if (userInfo?.secUid) secUid = String(userInfo.secUid);

  if (!secUid) {
    const detail = await fetchJson('/api/user/detail/?uniqueId=' + encodeURIComponent(username) + '&aid=1988');
    secUid = String(detail?.userInfo?.user?.secUid || detail?.user?.secUid || '');
  }
  if (!secUid) throw new Error('Cannot resolve secUid for @' + username);

  const dedup = new Map();
  const msToken = getCookie('msToken');
  let cursor = 0;
  let apiFailure = null;

  for (let page = 0; page < maxPages && dedup.size < limit; page += 1) {
    const params = new URLSearchParams({ secUid, count: String(pageSize), cursor: String(cursor), aid: '1988' });
    if (msToken) params.set('msToken', msToken);
    try {
      const data = await fetchJson('/api/post/item_list/?' + params.toString());
      const items = Array.isArray(data.itemList) ? data.itemList : [];
      for (const item of items) {
        const row = normalizeItem(item, dedup.size + 1);
        if (row && !dedup.has(row.id)) dedup.set(row.id, row);
      }
      if (!data.hasMore || items.length === 0) break;
      cursor = asNumber(data.cursor || cursor + items.length);
    } catch (error) {
      apiFailure = error instanceof Error ? error.message : String(error);
      break;
    }
  }

  if (dedup.size === 0 && universal) {
    for (const item of collectUniversalItems(universal, secUid)) {
      const row = normalizeItem(item, dedup.size + 1);
      if (row && !dedup.has(row.id)) dedup.set(row.id, row);
    }
  }

  if (dedup.size === 0) {
    for (let offset = 0; offset < limit * 3 && dedup.size < limit; offset += pageSize) {
      const params = new URLSearchParams({ keyword: username, offset: String(offset), count: String(pageSize), aid: '1988' });
      if (msToken) params.set('msToken', msToken);
      const data = await fetchJson('/api/search/general/full/?' + params.toString());
      const entries = Array.isArray(data.data) ? data.data : [];
      for (const entry of entries) {
        const item = entry?.item || entry?.itemStruct || entry;
        const author = item?.author || {};
        const authorName = String(author.uniqueId || author.unique_id || '').toLowerCase();
        if (entry?.type !== undefined && entry.type !== 1) continue;
        if (authorName !== username.toLowerCase()) continue;
        const row = normalizeItem(item, dedup.size + 1);
        if (row && !dedup.has(row.id)) dedup.set(row.id, row);
      }
    }
  }

  const rows = Array.from(dedup.values())
    .sort((a, b) => (b.createTime || 0) - (a.createTime || 0))
    .slice(0, limit)
    .map((row, index) => ({ ...row, index: index + 1 }));

  if (rows.length === 0) {
    const suffix = apiFailure ? ' (post-list API failed: ' + apiFailure + ')' : '';
    throw new Error('No videos found for @' + username + suffix);
  }

  return rows;
})()
`;
}


function mergeRows(primaryRows, fallbackRows, limit) {
    const dedup = new Map();
    for (const row of [...primaryRows, ...fallbackRows]) {
        if (row?.id && !dedup.has(row.id)) dedup.set(row.id, row);
    }
    return Array.from(dedup.values())
        .sort((a, b) => (Number(b.createTime) || 0) - (Number(a.createTime) || 0))
        .slice(0, limit)
        .map((row, index) => ({ ...row, index: index + 1 }));
}

function buildSearchFallbackScript(username, limit) {
    return `
(async () => {
  const username = ${JSON.stringify(username)};
  const limit = ${Number(limit)};
  const pageSize = Math.min(${SERVER_PAGE_MAX}, Math.max(1, limit));

  function asNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function cleanText(value, maxLength) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
  }

  function getCookie(name) {
    const prefix = name + '=';
    for (const part of document.cookie.split('; ')) {
      if (part.startsWith(prefix)) return decodeURIComponent(part.slice(prefix.length));
    }
    return '';
  }

  function normalizeItem(item, indexHint) {
    if (!item || typeof item !== 'object') return null;
    const id = String(item.id || '').trim();
    if (!id) return null;
    const author = item.author || {};
    const authorName = String(author.uniqueId || author.unique_id || '').replace(/^@+/, '');
    if (authorName.toLowerCase() !== username.toLowerCase()) return null;
    const stats = item.stats || item.statistics || item.statsV2 || {};
    const video = item.video || {};
    const cover = video.cover || video.originCover || video.dynamicCover || video.coverUrl || item.cover || '';
    const desc = cleanText(item.desc || item.title || item.description, 500);
    return {
      index: indexHint,
      id,
      url: 'https://www.tiktok.com/@' + encodeURIComponent(authorName || username) + '/video/' + encodeURIComponent(id),
      cover: String(cover || ''),
      title: desc,
      desc,
      plays: asNumber(stats.playCount ?? stats.play_count ?? stats.viewCount ?? stats.view_count),
      likes: asNumber(stats.diggCount ?? stats.digg_count ?? stats.likeCount ?? stats.like_count),
      comments: asNumber(stats.commentCount ?? stats.comment_count),
      shares: asNumber(stats.shareCount ?? stats.share_count),
      createTime: asNumber(item.createTime || item.create_time || item.post_time),
    };
  }

  async function fetchJson(url) {
    const requestUrl = new URL(url, 'https://www.tiktok.com').toString();
    const res = await fetch(requestUrl, { credentials: 'include', headers: { accept: 'application/json,text/plain,*/*' } });
    const text = await res.text();
    if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + requestUrl + ': ' + text.slice(0, 160));
    return text.trim() ? JSON.parse(text) : {};
  }

  const dedup = new Map();
  const msToken = getCookie('msToken');
  for (let offset = 0; offset < limit * 4 && dedup.size < limit; offset += pageSize) {
    const params = new URLSearchParams({ keyword: username, offset: String(offset), count: String(pageSize), aid: '1988' });
    if (msToken) params.set('msToken', msToken);
    const data = await fetchJson('/api/search/general/full/?' + params.toString());
    const entries = Array.isArray(data.data) ? data.data : [];
    for (const entry of entries) {
      if (entry?.type !== undefined && entry.type !== 1) continue;
      const row = normalizeItem(entry?.item || entry?.itemStruct || entry, dedup.size + 1);
      if (row && !dedup.has(row.id)) dedup.set(row.id, row);
    }
  }

  return Array.from(dedup.values())
    .sort((a, b) => (b.createTime || 0) - (a.createTime || 0))
    .slice(0, limit)
    .map((row, index) => ({ ...row, index: index + 1 }));
})()
`;
}

async function listUserVideos(page, args) {
    const username = normalizeUsername(args.username);
    const limit = requireLimit(args.limit);
    await page.goto(`https://www.tiktok.com/@${encodeURIComponent(username)}`, { waitUntil: 'load', settleMs: 6000 });
    let firstError = null;
    let rows = await page.evaluate(buildUserVideosScript(username, limit)).catch((error) => {
        firstError = getErrorMessage(error);
        return [];
    });
    if (!Array.isArray(rows)) rows = [];

    if (rows.length < limit) {
        await page.goto('https://www.tiktok.com/explore', { waitUntil: 'load', settleMs: 5000 });
        const fallbackRows = await page.evaluate(buildSearchFallbackScript(username, limit)).catch((error) => {
            if (rows.length > 0) return [];
            throw new CommandExecutionError(`Failed to fetch TikTok user videos: ${firstError || getErrorMessage(error)}`);
        });
        if (Array.isArray(fallbackRows) && fallbackRows.length > 0) {
            rows = mergeRows(rows, fallbackRows, limit);
        }
    }

    if (!Array.isArray(rows) || rows.length === 0) {
        throw new EmptyResultError('tiktok user', `No videos found for @${username}${firstError ? ` (${firstError})` : ''}`);
    }
    return rows;
}

export const userCommand = cli({
    site: 'tiktok',
    name: 'user',
    access: 'read',
    description: 'Get recent videos from a TikTok user via TikTok page-context APIs',
    domain: 'www.tiktok.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        {
            name: 'username',
            required: true,
            positional: true,
            help: 'TikTok username (without @)',
        },
        { name: 'limit', type: 'int', default: DEFAULT_LIMIT, help: `Number of videos to return (max ${MAX_LIMIT})` },
    ],
    columns: ['index', 'id', 'url', 'cover', 'title', 'desc', 'plays', 'likes', 'comments', 'shares', 'createTime'],
    func: listUserVideos,
});

export const __test__ = {
    buildUserVideosScript,
    buildSearchFallbackScript,
    mergeRows,
    normalizeUsername,
    requireLimit,
};
