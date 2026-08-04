import { describe, expect, it } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import './publish.js';
import { buildDeviceParams } from './publish.js';
describe('douyin publish registration', () => {
    it('registers the publish command', () => {
        const registry = getRegistry();
        const cmds = [...registry.values()];
        const cmd = cmds.find((c) => c.site === 'douyin' && c.name === 'publish');
        expect(cmd).toBeDefined();
        expect(cmd?.args.some((a) => a.name === 'video')).toBe(true);
        expect(cmd?.args.some((a) => a.name === 'title')).toBe(true);
        expect(cmd?.args.some((a) => a.name === 'schedule')).toBe(true);
    });
    it('has all expected args', () => {
        const registry = getRegistry();
        const cmd = [...registry.values()].find((c) => c.site === 'douyin' && c.name === 'publish');
        const argNames = cmd?.args.map((a) => a.name) ?? [];
        expect(argNames).toContain('video');
        expect(argNames).toContain('title');
        expect(argNames).toContain('schedule');
        expect(argNames).toContain('caption');
        expect(argNames).toContain('cover');
        expect(argNames).toContain('visibility');
        expect(argNames).toContain('allow_download');
        expect(argNames).toContain('collection');
        expect(argNames).toContain('activity');
        expect(argNames).toContain('poi_id');
        expect(argNames).toContain('poi_name');
        expect(argNames).toContain('hotspot');
        expect(argNames).toContain('no_safety_check');
        expect(argNames).toContain('sync_toutiao');
    });
    it('uses COOKIE strategy', () => {
        const registry = getRegistry();
        const cmd = [...registry.values()].find((c) => c.site === 'douyin' && c.name === 'publish');
        expect(cmd?.strategy).toBe('cookie');
    });
});
describe('buildDeviceParams (create_v2 device fingerprint)', () => {
    it('uses the real browser timezone, url-encoded, not the old hardcoded Tokyo', () => {
        const params = buildDeviceParams({
            timeZone: 'Asia/Shanghai',
            language: 'zh-CN',
            width: 1512,
            height: 982,
            platform: 'MacIntel',
        });
        expect(params).toContain('timezone_name=Asia%2FShanghai');
        expect(params).not.toContain('Tokyo');
    });
    it('reflects whatever real fingerprint the browser reports', () => {
        const params = buildDeviceParams({
            timeZone: 'America/Los_Angeles',
            language: 'en-US',
            width: 1920,
            height: 1080,
            platform: 'Win32',
        });
        const q = new URLSearchParams(params);
        expect(q.get('timezone_name')).toBe('America/Los_Angeles');
        expect(q.get('browser_language')).toBe('en-US');
        expect(q.get('screen_width')).toBe('1920');
        expect(q.get('screen_height')).toBe('1080');
        expect(q.get('browser_platform')).toBe('Win32');
    });
    it('falls back to mainland defaults on missing/empty fields', () => {
        const q = new URLSearchParams(buildDeviceParams({}));
        expect(q.get('timezone_name')).toBe('Asia/Shanghai');
        expect(q.get('browser_language')).toBe('zh-CN');
        expect(q.get('screen_width')).toBe('1512');
        expect(q.get('browser_platform')).toBe('MacIntel');
    });
});
