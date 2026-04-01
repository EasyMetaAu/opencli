/**
 * Jimeng AI video generation — text-to-video and reference-image/video-to-video.
 *
 * Phases:
 *   1. (Optional) Get STS2 upload credentials + upload chain for --ref-image / --ref-video
 *      - Images: ImageX (scene=3, imagex.bytedanceapi.com)
 *      - Videos: VOD    (scene=1, vod.bytedanceapi.com)
 *   2. Submit generation task via aigc_draft/generate
 *   3. (Optional) Poll for completion if --wait > 0
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cli, Strategy } from '../../registry.js';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '../../errors.js';
import type { IPage } from '../../types.js';
import { Buffer } from 'node:buffer';

// CRC32 lookup table
const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC32_TABLE[i] = c;
}
function computeCrc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ── Types ───────────────────────────────────────────────────────────────────

interface Sts2Credentials {
  access_key_id: string;
  secret_access_key: string;
  session_token: string;
  expired_time: number;
  space_name: string;
  upload_domain: string;
  region: string;
}

interface ModelConfig {
  benefit: string;
  root: string;
  reqKey: string;
}

const MODELS: Record<string, ModelConfig> = {
  seedance_20: { benefit: 'dreamina_seedance_20', root: 'dreamina_seedance_20', reqKey: 'dreamina_seedance_20' },
  seedance_20_fast: { benefit: 'dreamina_seedance_20_fast', root: 'dreamina_seedance_40', reqKey: 'dreamina_seedance_40' },
};

const IMAGEX_BASE = 'https://imagex.bytedanceapi.com';
const VOD_BASE = 'https://vod.bytedanceapi.com';
const JIMENG_API = '/mweb/v1';
const COMMON_PARAMS = 'aid=513695&web_version=7.5.0&da_version=3.3.12';

// ── AWS4 Signing (adapted from douyin tos-upload.ts) ────────────────────────

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: Buffer | string): string {
  const hash = crypto.createHash('sha256');
  if (typeof data === 'string') {
    hash.update(data, 'utf8');
  } else {
    hash.update(data);
  }
  return hash.digest('hex');
}

function nowDatetime(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function computeAws4Headers(opts: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer | string;
  credentials: { access_key_id: string; secret_access_key: string; session_token: string };
  service: string;
  region: string;
  datetime: string;
}): Record<string, string> {
  const { method, url, credentials, service, region, datetime } = opts;
  const date = datetime.slice(0, 8);

  const parsedUrl = new URL(url);
  const canonicalUri = parsedUrl.pathname || '/';
  const queryParams = [...parsedUrl.searchParams.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const bodyHash = sha256Hex(opts.body);

  const allHeaders: Record<string, string> = {
    ...opts.headers,
    host: parsedUrl.host,
    'x-amz-content-sha256': bodyHash,
    'x-amz-date': datetime,
    'x-amz-security-token': credentials.session_token,
  };

  const sortedHeaderKeys = Object.keys(allHeaders).sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase()),
  );

  const canonicalHeaders =
    sortedHeaderKeys.map((k) => `${k.toLowerCase()}:${allHeaders[k].trim()}`).join('\n') + '\n';

  const signedHeadersList = sortedHeaderKeys.map((k) => k.toLowerCase()).join(';');

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    queryParams,
    canonicalHeaders,
    signedHeadersList,
    bodyHash,
  ].join('\n');

  const credentialScope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    datetime,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmacSha256(`AWS4${credentials.secret_access_key}`, date);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = hmacSha256(kSigning, stringToSign).toString('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${credentials.access_key_id}/${credentialScope}, SignedHeaders=${signedHeadersList}, Signature=${signature}`;

  return { ...allHeaders, Authorization: authorization };
}

// ── ImageX upload chain ─────────────────────────────────────────────────────

async function getJimengSts2(page: IPage): Promise<Sts2Credentials> {
  const url = `${JIMENG_API}/get_upload_token?${COMMON_PARAMS}`;
  const js = `
    fetch(${JSON.stringify(url)}, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene: 3 })
    }).then(r => r.json())
  `;
  const res = (await page.evaluate(js)) as {
    ret: string | number;
    data?: Sts2Credentials;
    errmsg?: string;
  };

  if (res.ret === '1014' || res.ret === 1014) {
    throw new AuthRequiredError('jimeng.jianying.com', 'Not logged in');
  }
  if (res.ret !== '0' && res.ret !== 0) {
    throw new CommandExecutionError(
      `get_upload_token failed: ret=${res.ret} errmsg=${res.errmsg || ''}`,
    );
  }
  if (!res.data?.access_key_id) {
    throw new CommandExecutionError('get_upload_token returned no credentials');
  }
  return res.data;
}

interface ImageXApplyResult {
  storeUri: string;
  auth: string;
  uploadHost: string;
  sessionKey: string;
}

async function applyImageUpload(
  credentials: Sts2Credentials,
  fileSize: number,
): Promise<ImageXApplyResult> {
  const serviceId = credentials.space_name;
  const url = `${IMAGEX_BASE}/?Action=ApplyImageUpload&Version=2018-08-01&ServiceId=${serviceId}&FileSize=${fileSize}`;
  const datetime = nowDatetime();

  const headers = computeAws4Headers({
    method: 'GET',
    url,
    headers: {},
    body: '',
    credentials,
    service: 'imagex',
    region: credentials.region,
    datetime,
  });

  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new CommandExecutionError(`ApplyImageUpload failed: ${res.status} ${body}`);
  }
  const data = (await res.json()) as {
    Result: {
      UploadAddress: {
        StoreInfos: Array<{ StoreUri: string; Auth: string; UploadID: string }>;
        UploadHosts: string[];
        SessionKey: string;
      };
    };
  };

  const addr = data.Result?.UploadAddress;
  if (!addr?.StoreInfos?.[0]) {
    throw new CommandExecutionError(
      `ApplyImageUpload returned no StoreInfos: ${JSON.stringify(data).substring(0, 300)}`,
    );
  }

  return {
    storeUri: addr.StoreInfos[0].StoreUri,
    auth: addr.StoreInfos[0].Auth,
    uploadHost: addr.UploadHosts[0],
    sessionKey: addr.SessionKey,
  };
}

async function uploadImageFile(
  uploadHost: string,
  storeUri: string,
  auth: string,
  imageBuffer: Buffer,
): Promise<void> {
  const url = `https://${uploadHost}/upload/v1/${storeUri}`;

  // Compute CRC32 — TOS requires Content-CRC32 header
  const crc32 = computeCrc32(imageBuffer);
  const crc32Hex = crc32.toString(16).padStart(8, '0');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/octet-stream',
      'Content-CRC32': crc32Hex,
      'Content-Disposition': '',
      'X-Storage-U': '',
    },
    body: imageBuffer as unknown as BodyInit,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new CommandExecutionError(`Image upload failed: ${res.status} ${body}`);
  }

  const result = (await res.json()) as { code: number; message: string };
  if (result.code !== 2000) {
    throw new CommandExecutionError(`Image upload error: code=${result.code} ${result.message}`);
  }
}

interface CommitResult {
  uri: string;
  width: number;
  height: number;
}

async function commitImageUpload(
  credentials: Sts2Credentials,
  sessionKey: string,
): Promise<CommitResult> {
  const serviceId = credentials.space_name;
  const url = `${IMAGEX_BASE}/?Action=CommitImageUpload&Version=2018-08-01&ServiceId=${serviceId}`;
  const bodyStr = JSON.stringify({ SessionKey: sessionKey });
  const datetime = nowDatetime();

  const headers = computeAws4Headers({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    body: bodyStr,
    credentials,
    service: 'imagex',
    region: credentials.region,
    datetime,
  });

  const res = await fetch(url, { method: 'POST', headers, body: bodyStr });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new CommandExecutionError(`CommitImageUpload failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as {
    Result: {
      Results: Array<{ Uri: string; UriStatus: number }>;
      PluginResult: Array<{ ImageUri: string; ImageWidth: number; ImageHeight: number }>;
    };
  };

  const results = data.Result?.Results;
  if (!results?.[0] || results[0].UriStatus !== 2000) {
    throw new CommandExecutionError(
      `CommitImageUpload status error: ${JSON.stringify(data).substring(0, 300)}`,
    );
  }

  const plugin = data.Result.PluginResult?.[0];
  return {
    uri: results[0].Uri,
    width: plugin?.ImageWidth || 0,
    height: plugin?.ImageHeight || 0,
  };
}

// ── VOD upload chain (for --ref-video) ─────────────────────────────────────

/** Same endpoint as image STS2, but scene=1 for VOD. */
async function getJimengVodSts2(page: IPage): Promise<Sts2Credentials> {
  const url = `${JIMENG_API}/get_upload_token?${COMMON_PARAMS}`;
  const js = `
    fetch(${JSON.stringify(url)}, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene: 1 })
    }).then(r => r.json())
  `;
  const res = (await page.evaluate(js)) as {
    ret: string | number;
    data?: Sts2Credentials;
    errmsg?: string;
  };

  if (res.ret === '1014' || res.ret === 1014) {
    throw new AuthRequiredError('jimeng.jianying.com', 'Not logged in');
  }
  if (res.ret !== '0' && res.ret !== 0) {
    throw new CommandExecutionError(
      `get_upload_token (VOD) failed: ret=${res.ret} errmsg=${res.errmsg || ''}`,
    );
  }
  if (!res.data?.access_key_id) {
    throw new CommandExecutionError('get_upload_token (VOD) returned no credentials');
  }
  return res.data;
}

interface VodApplyResult {
  storeUri: string;
  auth: string;
  uploadHost: string;
  sessionKey: string;
  vid: string;
}

async function applyVodUpload(
  credentials: Sts2Credentials,
  fileSize: number,
  fileName: string,
): Promise<VodApplyResult> {
  const spaceName = credentials.space_name;
  const randomStr = crypto.randomBytes(8).toString('hex');
  const url = `${VOD_BASE}/?Action=ApplyUploadInner&Version=2020-11-19&SpaceName=${encodeURIComponent(spaceName)}&FileType=video&IsInner=1&FileSize=${fileSize}&s=${randomStr}`;
  const datetime = nowDatetime();

  const headers = computeAws4Headers({
    method: 'GET',
    url,
    headers: {},
    body: '',
    credentials,
    service: 'vod',
    region: 'cn-north-1',
    datetime,
  });

  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new CommandExecutionError(`ApplyUploadInner failed [${fileName}]: ${res.status} ${body}`);
  }
  const data = (await res.json()) as {
    ResponseMetadata?: { Error?: { Code: string; Message: string } };
    Result?: {
      UploadNodes?: Array<{
        UploadHost: string;
        StoreUri: string;
        Auth: string;
        SessionKey: string;
        Vid: string;
      }>;
    };
  };

  if (data.ResponseMetadata?.Error) {
    const e = data.ResponseMetadata.Error;
    throw new CommandExecutionError(`ApplyUploadInner error [${fileName}]: ${e.Code} ${e.Message}`);
  }

  const node = data.Result?.UploadNodes?.[0];
  if (!node) {
    throw new CommandExecutionError(
      `ApplyUploadInner returned no UploadNodes [${fileName}]: ${JSON.stringify(data).substring(0, 300)}`,
    );
  }

  return {
    storeUri: node.StoreUri,
    auth: node.Auth,
    uploadHost: node.UploadHost,
    sessionKey: node.SessionKey,
    vid: node.Vid,
  };
}

interface VodCommitResult {
  vid: string;
  width: number;
  height: number;
  durationMs: number;
  fps: number;
}

async function commitVodUpload(
  credentials: Sts2Credentials,
  sessionKey: string,
  fileName: string,
): Promise<VodCommitResult> {
  const spaceName = credentials.space_name;
  const url = `${VOD_BASE}/?Action=CommitUploadInner&Version=2020-11-19&SpaceName=${encodeURIComponent(spaceName)}`;
  const bodyStr = JSON.stringify({ SessionKey: sessionKey, Functions: [] });
  const datetime = nowDatetime();

  const headers = computeAws4Headers({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    body: bodyStr,
    credentials,
    service: 'vod',
    region: 'cn-north-1',
    datetime,
  });

  const res = await fetch(url, { method: 'POST', headers, body: bodyStr });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new CommandExecutionError(`CommitUploadInner failed [${fileName}]: ${res.status} ${body}`);
  }

  const data = (await res.json()) as {
    ResponseMetadata?: { Error?: { Code: string; Message: string } };
    Result?: {
      Results?: Array<{
        Vid: string;
        VideoMeta?: { Width: number; Height: number; Duration: number; Fps: number };
      }>;
    };
  };

  if (data.ResponseMetadata?.Error) {
    const e = data.ResponseMetadata.Error;
    throw new CommandExecutionError(`CommitUploadInner error [${fileName}]: ${e.Code} ${e.Message}`);
  }

  const result = data.Result?.Results?.[0];
  if (!result?.Vid) {
    throw new CommandExecutionError(
      `CommitUploadInner returned no Vid [${fileName}]: ${JSON.stringify(data).substring(0, 300)}`,
    );
  }

  const meta = result.VideoMeta;
  return {
    vid: result.Vid,
    width: meta?.Width || 0,
    height: meta?.Height || 0,
    // VOD returns Duration in seconds (float); convert to ms
    durationMs: meta?.Duration ? Math.round(meta.Duration * 1000) : 0,
    fps: meta?.Fps || 0,
  };
}

async function applyVodUploadAudio(
  credentials: Sts2Credentials,
  fileSize: number,
  fileName: string,
): Promise<VodApplyResult> {
  const spaceName = credentials.space_name;
  const randomStr = crypto.randomBytes(8).toString('hex');
  const url = `${VOD_BASE}/?Action=ApplyUploadInner&Version=2020-11-19&SpaceName=${encodeURIComponent(spaceName)}&FileType=audio&IsInner=1&FileSize=${fileSize}&s=${randomStr}`;
  const datetime = nowDatetime();

  const headers = computeAws4Headers({
    method: 'GET',
    url,
    headers: {},
    body: '',
    credentials,
    service: 'vod',
    region: 'cn-north-1',
    datetime,
  });

  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new CommandExecutionError(`ApplyUploadInner failed [applyAudio][${fileName}]: ${res.status} ${body}`);
  }
  const data = (await res.json()) as {
    ResponseMetadata?: { Error?: { Code: string; Message: string } };
    Result?: {
      UploadNodes?: Array<{
        UploadHost: string;
        StoreUri: string;
        Auth: string;
        SessionKey: string;
        Vid: string;
      }>;
    };
  };

  if (data.ResponseMetadata?.Error) {
    const e = data.ResponseMetadata.Error;
    throw new CommandExecutionError(`ApplyUploadInner error [applyAudio][${fileName}]: ${e.Code} ${e.Message}`);
  }

  const node = data.Result?.UploadNodes?.[0];
  if (!node) {
    throw new CommandExecutionError(
      `ApplyUploadInner returned no UploadNodes [applyAudio][${fileName}]: ${JSON.stringify(data).substring(0, 300)}`,
    );
  }

  return {
    storeUri: node.StoreUri,
    auth: node.Auth,
    uploadHost: node.UploadHost,
    sessionKey: node.SessionKey,
    vid: node.Vid,
  };
}

async function commitVodUploadAudio(
  credentials: Sts2Credentials,
  sessionKey: string,
  fileName: string,
): Promise<{ vid: string; durationMs: number }> {
  const spaceName = credentials.space_name;
  const url = `${VOD_BASE}/?Action=CommitUploadInner&Version=2020-11-19&SpaceName=${encodeURIComponent(spaceName)}`;
  const bodyStr = JSON.stringify({ SessionKey: sessionKey, Functions: [] });
  const datetime = nowDatetime();

  const headers = computeAws4Headers({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    body: bodyStr,
    credentials,
    service: 'vod',
    region: 'cn-north-1',
    datetime,
  });

  const res = await fetch(url, { method: 'POST', headers, body: bodyStr });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new CommandExecutionError(`CommitUploadInner failed [commitAudio][${fileName}]: ${res.status} ${body}`);
  }

  const data = (await res.json()) as {
    ResponseMetadata?: { Error?: { Code: string; Message: string } };
    Result?: {
      Results?: Array<{
        Vid: string;
        AudioMeta?: { Duration: number };
      }>;
    };
  };

  if (data.ResponseMetadata?.Error) {
    const e = data.ResponseMetadata.Error;
    throw new CommandExecutionError(`CommitUploadInner error [commitAudio][${fileName}]: ${e.Code} ${e.Message}`);
  }

  const result = data.Result?.Results?.[0];
  if (!result?.Vid) {
    throw new CommandExecutionError(
      `CommitUploadInner returned no Vid [commitAudio][${fileName}]: ${JSON.stringify(data).substring(0, 300)}`,
    );
  }

  return {
    vid: result.Vid,
    durationMs: result.AudioMeta?.Duration ? Math.round(result.AudioMeta.Duration * 1000) : 0,
  };
}

/**
 * Full VOD upload chain for audio: STS2 (scene=1) -> Apply (FileType=audio) -> Upload -> Commit.
 * Returns vid and audio metadata for use in the draft payload.
 */
async function uploadRefAudio(
  page: IPage,
  audioPath: string,
): Promise<{ vid: string; durationMs: number; name: string }> {
  const resolvedPath = path.resolve(audioPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new ArgumentError(`[uploadAudio][${path.basename(resolvedPath)}]: file not found: ${resolvedPath}`);
  }

  const audioBuffer = fs.readFileSync(resolvedPath);
  const fileSize = audioBuffer.byteLength;
  if (fileSize === 0) {
    throw new ArgumentError(`[uploadAudio][${path.basename(resolvedPath)}]: file is empty: ${resolvedPath}`);
  }

  const fileName = path.basename(resolvedPath);

  // Step 0: STS2 credentials (VOD scene=1)
  const credentials = await getJimengVodSts2(page);

  // Step 1: ApplyUploadInner (FileType=audio)
  const applyResult = await applyVodUploadAudio(credentials, fileSize, fileName);

  // Step 2: Upload binary (reuse existing TOS upload)
  await uploadImageFile(applyResult.uploadHost, applyResult.storeUri, applyResult.auth, audioBuffer);

  // Step 3: CommitUploadInner (AudioMeta)
  const result = await commitVodUploadAudio(credentials, applyResult.sessionKey, fileName);

  return {
    vid: result.vid,
    durationMs: result.durationMs,
    name: fileName,
  };
}

/**
 * Full VOD upload chain: STS2 (scene=1) -> Apply -> Upload -> Commit.
 * Returns vid and video metadata for use in the draft payload.
 */
async function uploadRefVideo(
  page: IPage,
  videoPath: string,
): Promise<{ vid: string; width: number; height: number; durationMs: number; fps: number; name: string }> {
  const resolvedPath = path.resolve(videoPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new ArgumentError(`参考视频文件不存在: ${resolvedPath}`);
  }

  const videoBuffer = fs.readFileSync(resolvedPath);
  const fileSize = videoBuffer.byteLength;
  if (fileSize === 0) {
    throw new ArgumentError(`参考视频文件为空: ${resolvedPath}`);
  }

  const fileName = path.basename(resolvedPath);

  // Step 0: STS2 credentials (VOD scene=1)
  const credentials = await getJimengVodSts2(page);

  // Step 1: ApplyUploadInner
  const applyResult = await applyVodUpload(credentials, fileSize, fileName);

  // Step 2: Upload binary (same TOS upload as images)
  await uploadImageFile(applyResult.uploadHost, applyResult.storeUri, applyResult.auth, videoBuffer);

  // Step 3: CommitUploadInner
  const result = await commitVodUpload(credentials, applyResult.sessionKey, fileName);

  return {
    vid: result.vid,
    width: result.width,
    height: result.height,
    durationMs: result.durationMs,
    fps: result.fps,
    name: fileName,
  };
}

/**
 * Full ImageX upload chain: STS2 -> Apply -> Upload -> Commit.
 * Returns the image URI and dimensions for use in the draft payload.
 */
async function uploadRefImage(
  page: IPage,
  imagePath: string,
): Promise<{ uri: string; width: number; height: number }> {
  const resolvedPath = path.resolve(imagePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new ArgumentError(`参考图片文件不存在: ${resolvedPath}`);
  }

  const imageBuffer = fs.readFileSync(resolvedPath);
  const fileSize = imageBuffer.byteLength;
  if (fileSize === 0) {
    throw new ArgumentError(`参考图片文件为空: ${resolvedPath}`);
  }

  // Read local image dimensions as fallback
  const localDims = readImageDimensions(imageBuffer);

  // Step 0: STS2 credentials
  const credentials = await getJimengSts2(page);

  // Step 1: ApplyImageUpload
  const applyResult = await applyImageUpload(credentials, fileSize);

  // Step 2: Upload file
  await uploadImageFile(applyResult.uploadHost, applyResult.storeUri, applyResult.auth, imageBuffer);

  // Step 3: CommitImageUpload
  const result = await commitImageUpload(credentials, applyResult.sessionKey);

  // Use server-reported dimensions, fallback to local reading
  if (!result.width || !result.height) {
    result.width = localDims.width;
    result.height = localDims.height;
  }

  return result;
}

/** Read width/height from PNG or JPEG header without external deps. */
function readImageDimensions(buf: Buffer): { width: number; height: number } {
  // PNG: bytes 16-23 contain width (4B) and height (4B) in IHDR
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: scan for SOF0/SOF2 marker (0xFF 0xC0 or 0xFF 0xC2)
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] === 0xff) {
        const marker = buf[i + 1];
        if (marker === 0xc0 || marker === 0xc2) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        }
        const len = buf.readUInt16BE(i + 2);
        i += 2 + len;
      } else {
        i++;
      }
    }
  }
  // WebP: RIFF header, VP8 chunk
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
    if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x20) {
      // VP8 lossy
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
  }
  return { width: 0, height: 0 };
}

// ── Draft content builder ───────────────────────────────────────────────────

export function buildImageInfo(image: { uri: string; width: number; height: number }): Record<string, unknown> {
  return {
    type: 'image', id: crypto.randomUUID(),
    source_from: 'upload',
    platform_type: 1,
    name: '',
    image_uri: image.uri,
    aigc_image: { type: '', id: crypto.randomUUID() },
    width: image.width,
    height: image.height,
    format: '',
    uri: image.uri,
  };
}

export function buildVideoInfo(video: {
  vid: string;
  fps: number;
  width: number;
  height: number;
  durationMs: number;
  name: string;
}): Record<string, unknown> {
  return {
    type: 'video', id: crypto.randomUUID(),
    source_from: 'upload',
    name: video.name,
    vid: video.vid,
    fps: video.fps,
    width: video.width,
    height: video.height,
    duration: video.durationMs, // milliseconds
  };
}

export function buildAudioInfo(audio: { vid: string; durationMs: number; name: string }): Record<string, unknown> {
  return {
    type: 'audio',
    id: crypto.randomUUID(),
    source_from: 'upload',
    name: audio.name,
    vid: audio.vid,
    duration: audio.durationMs, // milliseconds
  };
}

export function buildDraftContent(opts: {
  prompt: string;
  ratio: string;
  duration: number;
  modelCfg: ModelConfig;
  refImages?: Array<{ uri: string; width: number; height: number }>;
  refVideo?: { vid: string; fps: number; width: number; height: number; durationMs: number; name: string };
  refAudio?: { vid: string; durationMs: number; name: string };
  firstFrame?: { uri: string; width: number; height: number };
  lastFrame?: { uri: string; width: number; height: number };
}): string {
  const { prompt, ratio, duration, modelCfg, refImages, refVideo, refAudio, firstFrame, lastFrame } = opts;
  const draftId = crypto.randomUUID();
  const componentId = crypto.randomUUID();

  // Mode detection (mutually exclusive)
  const mode = refAudio ? 'ref-audio' : refVideo ? 'ref-video' : refImages?.length ? 'ref' : firstFrame ? (lastFrame ? 'first-last' : 'first') : 'text';

  const videoGenInput: Record<string, unknown> = {
    type: '', id: crypto.randomUUID(),
    min_version: '3.3.9',
    prompt: mode === 'text' ? prompt : '',
    video_mode: 2, fps: 24,
    duration_ms: duration * 1000,
    idip_meta_list: [],
  };

  // First-frame mode: image goes to first_frame_image only
  if (mode === 'first' || mode === 'first-last') {
    videoGenInput.first_frame_image = buildImageInfo(firstFrame!);
    // Text prompt for first-frame mode goes into prompt field
    videoGenInput.prompt = prompt;
  }

  // Last-frame mode: image goes to last_frame_image only
  if (mode === 'first-last' && lastFrame) {
    videoGenInput.last_frame_image = buildImageInfo(lastFrame);
  }

  // Unified reference mode: image goes to unified_edit_input
  if (mode === 'ref' && refImages?.length) {
    videoGenInput.unified_edit_input = {
      type: '', id: crypto.randomUUID(),
      material_list: refImages.map((image) => ({
        type: '', id: crypto.randomUUID(),
        material_type: 'image',
        image_info: buildImageInfo(image),
      })),
      meta_list: [{
        type: '', id: crypto.randomUUID(),
        meta_type: 'text',
        text: prompt || '参考图片生成视频',
      }],
    };
  }

  // Unified reference mode: video goes to unified_edit_input
  if (mode === 'ref-video' && refVideo) {
    videoGenInput.unified_edit_input = {
      type: '', id: crypto.randomUUID(),
      material_list: [{
        type: '', id: crypto.randomUUID(),
        material_type: 'video',
        video_info: buildVideoInfo(refVideo),
      }],
      meta_list: [{
        type: '', id: crypto.randomUUID(),
        meta_type: 'text',
        text: prompt || '参考视频生成视频',
      }],
    };
  }

  // Unified reference mode: audio goes to unified_edit_input
  if (mode === 'ref-audio' && refAudio) {
    videoGenInput.unified_edit_input = {
      type: '', id: crypto.randomUUID(),
      material_list: [{
        type: '', id: crypto.randomUUID(),
        material_type: 'audio',
        audio_info: buildAudioInfo(refAudio),
      }],
      meta_list: [{
        type: '', id: crypto.randomUUID(),
        meta_type: 'text',
        text: prompt || '参考音频生成视频',
      }],
    };
  }

  const component: Record<string, unknown> = {
    type: 'video_base_component', id: componentId,
    min_version: '1.0.0', aigc_mode: 'workbench',
    metadata: {
      type: '', id: crypto.randomUUID(),
      created_platform: 3, created_platform_version: '',
      created_time_in_ms: String(Date.now()), created_did: '',
    },
    generate_type: 'gen_video',
    abilities: {
      type: '', id: crypto.randomUUID(),
      gen_video: {
        type: '', id: crypto.randomUUID(),
        text_to_video_params: {
          type: '', id: crypto.randomUUID(),
          video_gen_inputs: [videoGenInput],
          video_aspect_ratio: ratio,
          seed: Math.floor(Math.random() * 4294967295),
          model_req_key: modelCfg.reqKey,
          priority: 0,
        },
      },
    },
    process_type: 1,
  };


  const minFeatures: string[] = [];
  if (mode === 'ref' || mode === 'ref-video' || mode === 'ref-audio') {
    minFeatures.push('AIGC_Video_UnifiedEdit');
  }

  return JSON.stringify({
    type: 'draft', id: draftId,
    min_version: '3.3.9',
    min_features: minFeatures,
    is_from_tsn: true,
    version: '3.3.12', main_component_id: componentId,
    component_list: [component],
  });
}

// ── Jimeng browser-side API helpers ─────────────────────────────────────────

async function jimengFetch(
  page: IPage,
  endpoint: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const url = `${JIMENG_API}/${endpoint}?${COMMON_PARAMS}`;
  const js = `
    fetch(${JSON.stringify(url)}, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: ${JSON.stringify(JSON.stringify(body))}
    }).then(r => r.json())
  `;
  return (await page.evaluate(js)) as Record<string, unknown>;
}

function checkRet(res: Record<string, unknown>, context: string, taskId?: string): void {
  const ret = res.ret;
  if (ret === '1014' || ret === 1014) {
    throw new AuthRequiredError(
      'jimeng.jianying.com',
      taskId ? `Session expired during ${context}, task_id=${taskId}` : `Not logged in`,
    );
  }
  if (ret === '5001' || ret === 5001) {
    throw new CommandExecutionError(
      'Insufficient credits for this model/duration — try seedance_20_fast or shorter duration',
    );
  }
  if (ret !== '0' && ret !== 0) {
    const suffix = taskId ? `, task_id=${taskId}` : '';
    throw new CommandExecutionError(
      `${context} failed: ret=${ret} errmsg=${(res.errmsg as string) || ''}${suffix}`,
    );
  }
}

// ── Parameter validation ────────────────────────────────────────────────────

/**
 * Validate that image/video-mode flags are mutually exclusive.
 * Throws ArgumentError for invalid combinations.
 */
export function validateVideoParams(opts: {
  refImagePaths: string[];
  refVideoPath?: string;
  refAudioPath?: string;
  firstFramePath: string;
  lastFramePath: string;
}): void {
  const { refImagePaths, refVideoPath = '', refAudioPath = '', firstFramePath, lastFramePath } = opts;
  const hasRefImages = refImagePaths.length > 0;
  const hasRefVideo = refVideoPath.length > 0;
  const hasRefAudio = refAudioPath.length > 0;

  if (lastFramePath && !firstFramePath) {
    throw new ArgumentError('--last-frame cannot be used without --first-frame');
  }
  if (hasRefImages && firstFramePath) {
    throw new ArgumentError('--ref-image cannot be used with --first-frame (mutually exclusive modes)');
  }
  if (hasRefImages && lastFramePath) {
    throw new ArgumentError('--ref-image cannot be used with --last-frame (mutually exclusive modes)');
  }
  if (hasRefVideo && hasRefImages) {
    throw new ArgumentError('--ref-video cannot be used with --ref-image (mutually exclusive modes)');
  }
  if (hasRefVideo && firstFramePath) {
    throw new ArgumentError('--ref-video cannot be used with --first-frame (mutually exclusive modes)');
  }
  if (hasRefVideo && lastFramePath) {
    throw new ArgumentError('--ref-video cannot be used with --last-frame (mutually exclusive modes)');
  }
  if (hasRefAudio && hasRefImages) {
    throw new ArgumentError('--ref-audio cannot be used with --ref-image (mutually exclusive modes)');
  }
  if (hasRefAudio && hasRefVideo) {
    throw new ArgumentError('--ref-audio cannot be used with --ref-video (mutually exclusive modes)');
  }
  if (hasRefAudio && firstFramePath) {
    throw new ArgumentError('--ref-audio cannot be used with --first-frame (mutually exclusive modes)');
  }
  if (hasRefAudio && lastFramePath) {
    throw new ArgumentError('--ref-audio cannot be used with --last-frame (mutually exclusive modes)');
  }
}

export function parseRefImagePaths(refImageArg: string): string[] {
  return refImageArg
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

// ── Command registration ────────────────────────────────────────────────────

cli({
  site: 'jimeng',
  name: 'video',
  description: '即梦AI 视频生成 — 文生视频 / 首帧视频 / 首尾帧视频 / 参考图生视频',
  domain: 'jimeng.jianying.com',
  strategy: Strategy.COOKIE,
  args: [
    { name: 'prompt', positional: true, type: 'string', required: true, help: '视频描述 prompt' },
    { name: 'model', type: 'string', default: 'seedance_20_fast', help: '模型: seedance_20 (Seedance 2.0), seedance_20_fast (Seedance 2.0 Fast)' },
    { name: 'ratio', type: 'string', default: '16:9', help: '宽高比: 16:9, 9:16, 1:1' },
    { name: 'duration', type: 'int', default: 4, help: '时长（秒）: 4, 10, 15' },
    { name: 'workspace', type: 'string', default: '0', help: 'workspace ID（默认 0）' },
    { name: 'wait', type: 'int', default: 0, help: '轮询等待秒数（默认 0 提交即返回，显式传值如 300 阻塞等结果）' },
    { name: 'ref-image', type: 'string', default: '', help: '参考图片路径，支持逗号分隔多张（全能参考模式：图片作为风格参考）' },
    { name: 'ref-video', type: 'string', default: '', help: '参考视频路径（全能参考模式：视频作为风格参考，与 --ref-image / --first-frame / --last-frame 互斥）' },
    { name: 'ref-audio', type: 'string', default: '', help: '参考音频路径（全能参考模式：音频作为风格参考，与 --ref-image / --ref-video / --first-frame / --last-frame 互斥）' },
    { name: 'first-frame', type: 'string', default: '', help: '首帧图片路径（首帧模式：图片作为视频第一帧）' },
    { name: 'last-frame', type: 'string', default: '', help: '尾帧图片路径（首尾帧模式：图片作为视频最后一帧，需配合 --first-frame）' },
  ],
  columns: ['status', 'task_id', 'video_url', 'queue_position'],
  navigateBefore: 'https://jimeng.jianying.com/ai-tool/generate?type=video&workspace=0',

  func: async (page: IPage, kwargs) => {
    const prompt = kwargs.prompt as string;
    const modelArg = kwargs.model as string;
    const ratio = kwargs.ratio as string;
    const duration = kwargs.duration as number;
    const waitSec = kwargs.wait as number;
    const workspaceId = parseInt(kwargs.workspace as string) || 0;
    const refImagePaths = parseRefImagePaths(kwargs['ref-image'] as string);
    const refVideoPath = kwargs['ref-video'] as string;
    const refAudioPath = kwargs['ref-audio'] as string;
    const firstFramePath = kwargs['first-frame'] as string;
    const lastFramePath = kwargs['last-frame'] as string;

    // Parameter validation: mutually exclusive modes
    validateVideoParams({ refImagePaths, refVideoPath, refAudioPath, firstFramePath, lastFramePath });

    const modelCfg = MODELS[modelArg] || MODELS['seedance_20_fast'];

    // ── Phase 1: Optional uploads ─────────────────────────────────────
    const refImages: Array<{ uri: string; width: number; height: number }> = [];
    let refVideo: { vid: string; fps: number; width: number; height: number; durationMs: number; name: string } | undefined;
    let refAudio: { vid: string; durationMs: number; name: string } | undefined;
    let firstFrame: { uri: string; width: number; height: number } | undefined;
    let lastFrame: { uri: string; width: number; height: number } | undefined;

    if (refImagePaths.length > 0) {
      process.stderr.write(`  上传参考图片（全能参考）共 ${refImagePaths.length} 张...\n`);
      for (const refImagePath of refImagePaths) {
        process.stderr.write(`  上传参考图片 ${refImages.length + 1}/${refImagePaths.length}...\n`);
        refImages.push(await uploadRefImage(page, refImagePath));
        process.stderr.write(`  上传完成: ${refImages[refImages.length - 1].uri}\n`);
      }
    }

    if (refVideoPath) {
      process.stderr.write('  上传参考视频（全能参考）...\n');
      refVideo = await uploadRefVideo(page, refVideoPath);
      process.stderr.write(`  参考视频上传完成: vid=${refVideo.vid}\n`);
    }

    if (refAudioPath) {
      process.stderr.write('  上传参考音频（全能参考）...\n');
      refAudio = await uploadRefAudio(page, refAudioPath);
      process.stderr.write(`  参考音频上传完成: vid=${refAudio.vid}\n`);
    }

    if (firstFramePath) {
      process.stderr.write('  上传首帧图片...\n');
      firstFrame = await uploadRefImage(page, firstFramePath);
      process.stderr.write(`  首帧图片上传完成: ${firstFrame.uri}\n`);
    }

    if (lastFramePath) {
      process.stderr.write('  上传尾帧图片...\n');
      lastFrame = await uploadRefImage(page, lastFramePath);
      process.stderr.write(`  尾帧图片上传完成: ${lastFrame.uri}\n`);
    }

    // ── Phase 2: Submit generation task ─────────────────────────────────
    const submitId = crypto.randomUUID();

    const body = {
      extend: {
        root_model: modelCfg.root,
        m_video_commerce_info: {
          benefit_type: modelCfg.benefit,
          resource_id: 'generate_video',
          resource_id_type: 'str',
          resource_sub_type: 'aigc',
        },
        workspace_id: workspaceId,
        m_video_commerce_info_list: [{
          benefit_type: modelCfg.benefit,
          resource_id: 'generate_video',
          resource_id_type: 'str',
          resource_sub_type: 'aigc',
        }],
      },
      submit_id: submitId,
      draft_content: buildDraftContent({ prompt, ratio, duration, modelCfg, refImages, refVideo, refAudio, firstFrame, lastFrame }),
      http_common_info: { aid: 513695 },
    };

    const submitResp = await jimengFetch(
      page,
      'aigc_draft/generate',
      body,
    );
    checkRet(submitResp, 'aigc_draft/generate');

    const submitData = submitResp.data as Record<string, unknown> | undefined;
    const aigcData = submitData?.aigc_data as Record<string, unknown> | undefined;
    const taskId =
      (aigcData?.history_record_id as string) ||
      ((aigcData?.task as Record<string, unknown>)?.task_id as string);

    if (!taskId) {
      throw new CommandExecutionError(
        `No task_id in response: ${JSON.stringify(submitResp).substring(0, 300)}`,
      );
    }

    // ── Phase 3a: If wait=0, return immediately ─────────────────────────
    if (waitSec <= 0) {
      const queueResp = await jimengFetch(page, 'get_history_queue_info', {
        history_ids: [taskId],
      }).catch(() => null);

      let queuePos = '';
      if (queueResp) {
        const qData = queueResp.data as Record<string, Record<string, unknown>> | undefined;
        const queueInfo = qData?.[taskId]?.queue_info as
          | { queue_idx: number; queue_length: number }
          | undefined;
        if (queueInfo) {
          queuePos = `${queueInfo.queue_idx}/${queueInfo.queue_length}`;
        }
      }

      return [{ status: 'queued', task_id: taskId, video_url: '', queue_position: queuePos }];
    }

    // ── Phase 3b: Poll for completion ───────────────────────────────────
    const pollInterval = 10;
    const maxPolls = Math.ceil(waitSec / pollInterval);

    for (let i = 0; i < maxPolls; i++) {
      await new Promise((r) => setTimeout(r, pollInterval * 1000));

      const queueResp = await jimengFetch(page, 'get_history_queue_info', {
        history_ids: [taskId],
      }).catch(() => null);

      if (!queueResp) continue;
      checkRet(queueResp, 'get_history_queue_info', taskId);

      const qData = queueResp.data as Record<string, Record<string, unknown>> | undefined;
      const taskInfo = qData?.[taskId];

      if (taskInfo?.status === 50) {
        // Completed — fetch result
        const resultResp = await jimengFetch(page, 'get_history_by_ids', {
          history_ids: [taskId],
        });
        checkRet(resultResp, 'get_history_by_ids', taskId);

        const rData = resultResp.data as Record<string, Record<string, unknown>> | undefined;
        const historyData = rData?.[taskId];
        const items = (historyData?.item_list as Array<{ video_url?: string }>) || [];
        const videoUrl = items[0]?.video_url || '';

        if (!videoUrl) {
          throw new CommandExecutionError(
            `Generation completed but no video_url in response, task_id=${taskId}`,
          );
        }

        return [{ status: 'completed', task_id: taskId, video_url: videoUrl, queue_position: '' }];
      }

      if (taskInfo?.status === 30) {
        throw new CommandExecutionError(`Video generation failed (status=30), task_id=${taskId}`);
      }
    }

    return [{
      status: 'timeout',
      task_id: taskId,
      video_url: '',
      queue_position: `poll timeout after ${waitSec}s`,
    }];
  },
});
