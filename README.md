# TV Kaynak Tarayıcı v3 (Render)

## Render
- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Environment: `ALLOWED_HOSTS=blog.canlitvizle.tv`
- `MAX_PAGES` (optional, default 30)
- `PAGE_WAIT_MS` (optional, default 9000)

This version uses Playwright + @sparticuz/chromium to open public pages and observe normal browser network requests for publicly exposed M3U/M3U8 playlist URLs. It does not bypass DRM, login, subscription, geo restrictions, or other access controls. Some sites require user interaction or third-party scripts and may not expose stream URLs to automated browsing. Temporary signed URLs may expire or be IP/session-bound.

The scanner only crawls same-host HTTPS pages under ALLOWED_HOSTS. The browser request route blocks non-HTTP(S) and obvious private/local literal destinations. Do not deploy this as a general-purpose open proxy; keep ALLOWED_HOSTS restricted to sites you are authorized to inspect.
