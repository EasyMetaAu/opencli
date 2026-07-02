// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { visibleElementScript } from './video-publish.js';

// clickByLabels lives inside the browser-injected source returned by
// visibleElementScript(). Eval it once so we can exercise the matching logic
// against a real (jsdom) DOM. This guards the regression where a substring
// label like "Post" clicked the left-nav "Posts" link instead of the submit
// button, which navigated away and popped TikTok's "exit?" confirm dialog.
const clickByLabels = new Function(`${visibleElementScript()}\nreturn clickByLabels;`)();

beforeAll(() => {
    // jsdom performs no layout, so getBoundingClientRect() returns an all-zero
    // box and isVisible() would reject every element. Report a non-zero box.
    Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
        configurable: true,
        value() {
            return { width: 120, height: 32, top: 0, left: 0, right: 120, bottom: 32, x: 0, y: 0, toJSON() {} };
        },
    });
});

afterEach(() => { document.body.innerHTML = ''; });

// Record which button-like element actually received the click.
function trackClicks() {
    let hit = null;
    for (const el of document.querySelectorAll('button, [role="button"]')) {
        el.addEventListener('click', () => { hit = el.id || el.textContent; });
    }
    return () => hit;
}

describe('clickByLabels — submit button vs left-nav', () => {
    it('clicks the "Post" submit button, not the left-nav "Posts" link', () => {
        document.body.innerHTML = `
            <nav><button id="nav-posts">Posts</button></nav>
            <div><button id="submit">Post</button></div>
        `;
        const hit = trackClicks();
        const r = clickByLabels(['Post now', 'Post', 'Publish']);
        expect(r.ok).toBe(true);
        expect(r.text).toBe('post');
        expect(hit()).toBe('submit');
    });

    it('prefers an exact "Post now" button even when a "Post" button precedes it', () => {
        document.body.innerHTML = `
            <nav><button id="nav-posts">Posts</button></nav>
            <button id="post">Post</button>
            <button id="postnow">Post now</button>
        `;
        const hit = trackClicks();
        const r = clickByLabels(['Post now', 'Post']);
        expect(r.text).toBe('post now');
        expect(hit()).toBe('postnow');
    });

    it('excludes nav containers entirely (no click when only a nav item matches)', () => {
        document.body.innerHTML = `<nav><button id="nav-post">Post</button></nav>`;
        const hit = trackClicks();
        const r = clickByLabels(['Post']);
        expect(r.ok).toBe(false);
        expect(hit()).toBe(null);
    });

    it('still falls back to substring matching for non-exact labels (YouTube-style)', () => {
        document.body.innerHTML = `<div><button id="up">Upload videos to channel</button></div>`;
        const hit = trackClicks();
        const r = clickByLabels(['Upload videos', '上传视频']);
        expect(r.ok).toBe(true);
        expect(hit()).toBe('up');
    });

    it('excludeWithin skips link-style nav items the substring fallback would otherwise click', () => {
        document.body.innerHTML = `<a href="/tiktokstudio/content" role="button" id="nav-posts">Posts</a>`;
        // jsdom attempts real navigation on a link click; suppress it for the test.
        document.getElementById('nav-posts').addEventListener('click', (e) => e.preventDefault());
        // Without the exclusion, the "Post" substring fallback clicks the nav link.
        const without = clickByLabels(['Post']);
        expect(without.ok).toBe(true);
        expect(without.tag).toBe('A');
        // With a[href] excluded, the nav link is skipped entirely -> no match.
        const r = clickByLabels(['Post'], { excludeWithin: 'a[href]' });
        expect(r.ok).toBe(false);
    });

    it('scheduled labels (no bare "Post") never match the left-nav "Posts" button', () => {
        document.body.innerHTML = `
            <button id="nav-posts">Posts</button>
            <button id="sch">Schedule</button>
        `;
        const hit = trackClicks();
        const r = clickByLabels(['预约发布', 'Schedule video', 'Schedule', '排程', '定时发布']);
        expect(r.ok).toBe(true);
        expect(r.tag).toBe('BUTTON');
        expect(hit()).toBe('sch');
    });
});

describe('clickByLabels — excludeLabels / exactOnly (disabled-submit regression)', () => {
    // TikTok Studio while the video is still uploading: the real "Post" submit is
    // disabled, and the left-nav "Posts" item is a button-like node OUTSIDE any
    // nav/aside/a[href] container — the shape observed live on 2026-07-02.
    const IMMEDIATE_LABELS = ['Post now', 'Post', 'Publish', '立即发布', '发布'];
    const DISABLED_SUBMIT_DOM = `
        <button id="nav-posts">Posts</button>
        <div><button id="submit" disabled>Post</button></div>
    `;

    it('without excludeLabels the substring fallback clicks the nav "Posts" (pins the bug)', () => {
        document.body.innerHTML = DISABLED_SUBMIT_DOM;
        const hit = trackClicks();
        const r = clickByLabels(IMMEDIATE_LABELS, { excludeWithin: 'a[href]' });
        expect(r.ok).toBe(true);
        expect(r.text).toBe('posts');
        expect(hit()).toBe('nav-posts');
    });

    it('excludeLabels keeps the nav "Posts" unclickable while the submit is disabled', () => {
        document.body.innerHTML = DISABLED_SUBMIT_DOM;
        const hit = trackClicks();
        const r = clickByLabels(IMMEDIATE_LABELS, { excludeWithin: 'a[href]', excludeLabels: ['posts'] });
        expect(r.ok).toBe(false);
        expect(hit()).toBe(null);
    });

    it('excludeLabels does not block the exact "Post" submit once it enables', () => {
        document.body.innerHTML = `
            <button id="nav-posts">Posts</button>
            <div><button id="submit">Post</button></div>
        `;
        const hit = trackClicks();
        const r = clickByLabels(IMMEDIATE_LABELS, { excludeWithin: 'a[href]', excludeLabels: ['posts'] });
        expect(r.ok).toBe(true);
        expect(r.text).toBe('post');
        expect(hit()).toBe('submit');
    });

    it('excludeLabels also covers a [role=button] nav item (live DOM shape)', () => {
        document.body.innerHTML = `
            <div role="button" id="nav-posts">Posts</div>
            <div><button id="submit" disabled>Post</button></div>
        `;
        const hit = trackClicks();
        const without = clickByLabels(IMMEDIATE_LABELS, { excludeWithin: 'a[href]' });
        expect(without.ok).toBe(true);
        expect(without.text).toBe('posts');
        const r = clickByLabels(IMMEDIATE_LABELS, { excludeWithin: 'a[href]', excludeLabels: ['posts'] });
        expect(r.ok).toBe(false);
        expect(hit()).toBe('nav-posts'); // only the unprotected first call clicked
    });

    it('exactOnly skips the substring fallback; default keeps it (YouTube contract)', () => {
        document.body.innerHTML = `<div><button id="up">Upload videos to channel</button></div>`;
        const strict = clickByLabels(['Upload videos'], { exactOnly: true });
        expect(strict.ok).toBe(false);
        const loose = clickByLabels(['Upload videos']);
        expect(loose.ok).toBe(true);
        expect(loose.text).toBe('upload videos to channel');
    });
});

describe('clickByLabels — attrSelector / disabled reporting', () => {
    // TikTok Studio immediate publish, live shape probed 2026-07-02: the real
    // submit is <button data-e2e="post_video_button">Post</button> and stays
    // disabled while the server processes the uploaded video.
    const IMMEDIATE_LABELS = ['Post now', 'Post', 'Publish', '立即发布', '发布'];
    const TIKTOK_OPTS = {
        excludeWithin: 'a[href]',
        excludeLabels: ['posts'],
        attrSelector: '[data-e2e="post_video_button"]',
    };

    it('attrSelector clicks the submit even when its text matches no label', () => {
        document.body.innerHTML = `
            <button id="nav-posts">Posts</button>
            <div><button id="submit" data-e2e="post_video_button">Ship it</button></div>
        `;
        const hit = trackClicks();
        const r = clickByLabels(IMMEDIATE_LABELS, { ...TIKTOK_OPTS, exactOnly: true });
        expect(r.ok).toBe(true);
        expect(hit()).toBe('submit');
    });

    it('reports found/disabled when the attrSelector submit is visible but disabled', () => {
        document.body.innerHTML = `
            <button id="nav-posts">Posts</button>
            <div><button id="submit" data-e2e="post_video_button" disabled>Post</button></div>
        `;
        const hit = trackClicks();
        const r = clickByLabels(IMMEDIATE_LABELS, { ...TIKTOK_OPTS, exactOnly: true });
        expect(r.ok).toBe(false);
        expect(r.found).toBe(true);
        expect(r.disabled).toBe(true);
        expect(hit()).toBe(null);
    });

    it('reports found/disabled from an exact text match without attrSelector', () => {
        document.body.innerHTML = `
            <button id="nav-posts">Posts</button>
            <div><button id="submit" disabled>Post</button></div>
        `;
        const r = clickByLabels(IMMEDIATE_LABELS, { excludeWithin: 'a[href]', excludeLabels: ['posts'], exactOnly: true });
        expect(r.ok).toBe(false);
        expect(r.found).toBe(true);
        expect(r.disabled).toBe(true);
    });

    it('keeps the plain not-found result when nothing matches at all', () => {
        document.body.innerHTML = `<div><button id="other">Something else</button></div>`;
        const r = clickByLabels(IMMEDIATE_LABELS, TIKTOK_OPTS);
        expect(r.ok).toBe(false);
        expect(r.found).toBeUndefined();
        expect(r.disabled).toBeUndefined();
        expect(r.message).toContain('button not found');
    });

    it('an aria-disabled attrSelector match also reports disabled (role=button shape)', () => {
        document.body.innerHTML = `
            <div role="button" id="submit" data-e2e="post_video_button" aria-disabled="true">Post</div>
        `;
        const r = clickByLabels(IMMEDIATE_LABELS, TIKTOK_OPTS);
        expect(r.ok).toBe(false);
        expect(r.disabled).toBe(true);
    });
});
