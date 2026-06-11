# PixelADB Open API Console

Console for the PixelADB Open API documented at https://okey188.com/api-docs.

It supports two modes:

- Local Node proxy mode on `localhost`, which avoids browser CORS issues.
- GitHub Pages static mode, which is publicly accessible but requires the PixelADB server to allow your Pages domain in `CORS_ORIGINS`.

## Run

```powershell
npm start
```

Open http://localhost:3000.

No package install is required. The server uses Node's built-in HTTP server and `fetch`.

## Configuration

Copy `.env.example` to `.env` if you want server-side defaults:

```env
PORT=3000
PIXEL_API_BASE_URL=https://okey188.com/api/v1/open
PIXEL_CDK=your-cdk
```

If `PIXEL_CDK` is blank, enter the CDK in the browser. The browser sends it only to the local proxy, which forwards it as `X-Pixel-CDK`.

## Publish With GitHub Pages

This repository includes `.github/workflows/pages.yml`. After pushing to GitHub:

1. Open the repository on GitHub.
2. Go to `Settings` -> `Pages`.
3. Set `Source` to `GitHub Actions`.
4. Push to `main` or run the `Deploy GitHub Pages` workflow manually.
5. Open the deployed URL shown by the workflow, usually `https://<user>.github.io/<repo>/`.

GitHub Pages serves files from `public/`.

### Important CORS Limitation

GitHub Pages is static hosting. It cannot run `server.mjs` or any backend proxy. The public Pages version calls:

```text
https://okey188.com/api/v1/open
```

directly from the browser. The PixelADB API currently rejects unapproved browser origins with `Disallowed CORS origin`, so the API owner must add your GitHub Pages domain to `CORS_ORIGINS`, for example:

```text
https://<user>.github.io
```

Without that allowlist change, the page will be online, but task submit/query/cancel/retry calls will be blocked by the browser.

If you need the public site to work without PixelADB CORS changes, deploy the Node app (`server.mjs`) to a real Node hosting provider instead of GitHub Pages, then keep `PIXEL_CDK` blank so each user enters their own CDK.

## Supported API Calls

- `POST /api/tasks` -> `POST /api/v1/open/tasks`
- `GET /api/tasks/:taskId` -> `GET /api/v1/open/tasks/{task_id}`
- `POST /api/tasks/:taskId/cancel` -> `POST /api/v1/open/tasks/{task_id}/cancel`
- `POST /api/tasks/:taskId/retry` -> `POST /api/v1/open/tasks/{task_id}/retry`

Task types:

- `full_subscribe`
- `full_subscribe_24m`
- `extract_link`

Account input accepts a JSON array, `{ "accounts": [...] }`, or one account per line in `email,password,totp,recovery` format.
