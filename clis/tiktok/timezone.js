// Read-only probe of the time zone the connected browser profile presents
// to TikTok (e.g. an AdsPower fingerprint browser). It never navigates —
// `navigateBefore: false` keeps the harness off the address bar too — and
// only evaluates Intl.DateTimeFormat().resolvedOptions().timeZone in the
// already-connected page.
//
// Typed errors:
//   CommandExecutionError — page reports a missing/invalid time zone, or
//   the evaluate itself fails. Fails closed: no row unless the page
//   reports a canonical non-empty IANA zone.
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError, getErrorMessage } from '@jackwener/opencli/errors';

const TIMEZONE_PROBE_SCRIPT = `(() => Intl.DateTimeFormat().resolvedOptions().timeZone)()`;

// "Area/Location" shape only (plus bare "UTC"): rejects offset spellings
// like "GMT+8:00" that some Intl builds would otherwise resolve, then lets
// Intl canonicalize and reject unknown zones like "Invalid/Zone".
function canonicalizeIanaTimeZone(value) {
    if (typeof value !== 'string') return null;
    const zone = value.trim();
    if (zone !== 'UTC' && !/^[A-Za-z_-]+(\/[A-Za-z0-9_+-]+)+$/.test(zone)) return null;
    try {
        return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
    } catch {
        return null;
    }
}

async function readPageTimezone(page) {
    const reported = await page.evaluate(TIMEZONE_PROBE_SCRIPT).catch((error) => {
        throw new CommandExecutionError(`TikTok page time zone probe failed: ${getErrorMessage(error)}`);
    });
    const timeZone = canonicalizeIanaTimeZone(reported);
    if (!timeZone) {
        throw new CommandExecutionError(
            `TikTok page reported a missing or non-IANA time zone: ${JSON.stringify(reported) ?? String(reported)}`,
            'Expected a canonical zone like "America/New_York" from Intl.DateTimeFormat().resolvedOptions().timeZone',
        );
    }
    return [{ timeZone }];
}

export const timezoneCommand = cli({
    site: 'tiktok',
    name: 'timezone',
    access: 'read',
    description: 'Report the IANA time zone the connected browser profile presents to TikTok',
    domain: 'www.tiktok.com',
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    columns: ['timeZone'],
    func: readPageTimezone,
});
