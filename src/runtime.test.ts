import { describe, it, expect, afterEach } from 'vitest';
import { getBrowserFactory } from './runtime.js';
import { BrowserBridge, CDPBridge } from './browser/index.js';

describe('getBrowserFactory', () => {
  const original = process.env.OPENCLI_CDP_ENDPOINT;

  afterEach(() => {
    if (original === undefined) delete process.env.OPENCLI_CDP_ENDPOINT;
    else process.env.OPENCLI_CDP_ENDPOINT = original;
  });

  it('uses BrowserBridge for a normal site adapter without an explicit endpoint', () => {
    delete process.env.OPENCLI_CDP_ENDPOINT;
    expect(getBrowserFactory('tiktok')).toBe(BrowserBridge);
    expect(getBrowserFactory('douyin')).toBe(BrowserBridge);
  });

  it('uses CDPBridge for a registered Electron app without an explicit endpoint', () => {
    delete process.env.OPENCLI_CDP_ENDPOINT;
    expect(getBrowserFactory('cursor')).toBe(CDPBridge);
  });

  it('uses CDPBridge for ANY site when OPENCLI_CDP_ENDPOINT is set (take over an external browser)', () => {
    process.env.OPENCLI_CDP_ENDPOINT = 'http://127.0.0.1:9222';
    expect(getBrowserFactory('tiktok')).toBe(CDPBridge);
    expect(getBrowserFactory('douyin')).toBe(CDPBridge);
    expect(getBrowserFactory('cursor')).toBe(CDPBridge);
  });

  it('uses BrowserBridge with no site and no explicit endpoint', () => {
    delete process.env.OPENCLI_CDP_ENDPOINT;
    expect(getBrowserFactory()).toBe(BrowserBridge);
  });
});
