# YouTube

**Mode**: 🔐 Browser · **Domain**: `youtube.com`

## Commands

| Command | Description |
|---------|-------------|
| `opencli youtube search` | Search videos |
| `opencli youtube video` | Get video metadata |
| `opencli youtube transcript` | Get video transcript/subtitles |
| `opencli youtube comments` | Get video comments |
| `opencli youtube channel` | Get channel info and videos |
| `opencli youtube playlist` | Get playlist video list |
| `opencli youtube feed` | Homepage recommended videos |
| `opencli youtube history` | Watch history |
| `opencli youtube watch-later` | Watch Later queue |
| `opencli youtube subscriptions` | List subscribed channels |
| `opencli youtube publish` | Upload and publish a local video through YouTube Studio |
| `opencli youtube like` | Like a video |
| `opencli youtube unlike` | Remove like from a video |
| `opencli youtube subscribe` | Subscribe to a channel |
| `opencli youtube unsubscribe` | Unsubscribe from a channel |

## Usage Examples

```bash
# Read commands
opencli youtube feed --limit 10
opencli youtube history --limit 20
opencli youtube watch-later --limit 50
opencli youtube subscriptions --limit 30

# Search and video info
opencli youtube search "rust programming" --limit 5
opencli youtube video "https://www.youtube.com/watch?v=xxx"
opencli youtube transcript "https://www.youtube.com/watch?v=xxx"
opencli youtube channel @ChannelHandle --tab shorts --limit 10
opencli youtube channel "https://www.youtube.com/@ChannelHandle/shorts" --limit 10

# Publish a local video and return structured JSON
opencli youtube publish ./video.mp4 \
  --title "Launch demo" \
  --description "Uploaded by OpenCLI" \
  --tags "opencli,demo" \
  --privacy public \
  --format json

# Write commands (requires login)
opencli youtube like "https://www.youtube.com/watch?v=xxx"
opencli youtube unlike "videoId"
opencli youtube subscribe "@ChannelHandle"
opencli youtube unsubscribe "UCxxxxxxxxxxxxxx"
```

## `publish`

`publish` uploads a local video through YouTube Studio using the active browser session and returns one structured row. Use `--format json` for Social Hub or other server-side integrations.

| Column | Type | Notes |
|--------|------|-------|
| `ok` | bool | `true` only when OpenCLI observed a publish/save success signal |
| `platform` | string | `youtube` |
| `status` | enum | `success` / `unsupported` |
| `code` | enum | `success` / `unsupported_capability` |
| `capability` | string | Unsupported capability name, otherwise empty |
| `message` | string | Human-readable publish result or failure reason |
| `url` | string | Published video URL when YouTube Studio exposes it after publish |
| `draft` | bool | Always `false` for the current immediate-publish path |

Capability matrix:

| Capability | Status | Notes |
|------------|--------|-------|
| Immediate publish | Supported | `opencli youtube publish <video> --title ... --format json` |
| Draft | Unsupported | Returns `code=unsupported_capability`, `capability=draft` |
| Scheduled publish | Unsupported | Returns `capability=schedule`; no silent downgrade to immediate publish |
| Cover / thumbnail | Unsupported | Returns `capability=cover` |
| Tags | Supported as description hashtags | Comma-separated `--tags` are appended to the description as `#tags`; Studio metadata tags are not automated |
| Privacy | Supported | `public`, `unlisted`, and `private` visibility are selected in Studio when the UI exposes the radio buttons |
| Account / channel selection | Unsupported | Uses the active YouTube Studio channel |

Typed failures: invalid file/title/tag input raises `ArgumentError`; missing or expired login raises `AuthRequiredError`; missing browser upload support returns `browser_unsupported`; upload input/file-transfer failures return `upload_failed`; Studio UI/platform state failures return `platform_error`. This gives service callers stable success, relogin, unsupported capability, validation, upload, browser-capability, and platform-failure branches without parsing browser logs.

## Prerequisites

- Chrome running and **logged into** youtube.com / studio.youtube.com
- The logged-in channel must have access to YouTube Studio video uploads
- [Browser Bridge extension](/guide/browser-bridge) installed
