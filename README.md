# Spectre

Spectre is a task and notes app with a React frontend, NestJS API, and Supabase Auth/Postgres backend.

## Requirements

- Node.js 22 or later
- pnpm 11 or later

## Run locally

```powershell
pnpm install
pnpm dev
```

The React app runs at `http://localhost:5173`; Vite proxies `/api` calls to NestJS at `http://localhost:3000`. Guest task data is scoped by a persistent random installation ID. Supabase stores the guest account mapping and scoped app state. The installation ID is not an authentication credential. When a guest signs up or logs in, the app asks before merging guest data into the account; matching tasks and notes are skipped, and existing account items are preserved. No previous local JSON records are imported.

## Supabase project setup

The target Supabase project is `lgseazfkoqaozavyozno` (`https://lgseazfkoqaozavyozno.supabase.co`). In Supabase Dashboard, open **SQL Editor**, create a query, paste and run `supabase/migrations/202611010001_initial.sql`, followed by `supabase/migrations/202611010002_add_spectre_data_revision.sql`. This creates an empty app schema and does not import local JSON data. Under **Project Settings → API Keys**, create/copy a server-side **Secret key**, and keep it private. Do not place it in frontend variables or commit it.

Copy `backend/.env.example` to `backend/.env`, then put your Secret key in `SUPABASE_SECRET_KEY`. Node loads this file when the NestJS server starts. The `.env` file is ignored by Git. In Supabase **Authentication → URL Configuration**, allow `http://localhost:5173/**` as a redirect URL for password reset links. Configure Supabase Auth email delivery before relying on password recovery in production.

For a local connection check in PowerShell, from the repository root run:

```powershell
$env:SUPABASE_URL = 'https://lgseazfkoqaozavyozno.supabase.co'
$supabaseSecretSecure = Read-Host 'Supabase Secret key' -AsSecureString
$env:SUPABASE_SECRET_KEY = [System.Net.NetworkCredential]::new('', $supabaseSecretSecure).Password
pnpm dev
```

With the backend running, open `http://localhost:3000/api/health/supabase`. A successful response confirms the server key can reach the schema. Ensure the project Auth redirect allowlist includes the frontend URL as described below.

## Authentication and email reminders

Normal task use is available as a guest. Supabase Auth manages email/password accounts, password hashing, and password recovery. The NestJS API places access and refresh tokens in a Secure-in-production, HttpOnly cookie. Scheduled actions require an account. Guest data is transferred only after the user confirms the merge.

Email delivery uses Resend's Email API. Set these backend environment variables to enable delivery:

- `RESEND_API_KEY` (create an API key in Resend)
- `EMAIL_FROM` (an address on a verified Resend domain)
- `APP_URL` (the public app URL used by reminder links)
- `APP_NAME` (optional; defaults to Spectre)

The optional voice assistant interprets reminder requests through Google's Gemini API. Create an API key in [Google AI Studio](https://aistudio.google.com/app/apikey), then add `GEMINI_API_KEY` to the **backend** environment. `GEMINI_MODEL` is optional and defaults to `gemini-3.8-flash`. Keep the key out of Vite/frontend variables. The browser uses its built-in speech recognition and speech synthesis where supported; typed requests remain available when voice recognition is unavailable. Audio is not uploaded or stored; only recognized text is sent to the backend. The assistant produces a draft and never creates or schedules it until the user confirms. Personal reminders use the existing task API; email reminders use the authenticated scheduled-action API and existing Resend configuration.

Supabase Auth sends password reset links; Resend sends scheduled reminder emails. In production set `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`, `APP_URL`, and `WEB_ORIGIN`. Verify a sending domain in Resend and use a sender address from that domain; a test sender can only be used within Resend's test restrictions. `APP_URL` must be the browser-visible application URL, and `WEB_ORIGIN` must match the frontend origin if the API is cross-origin. The frontend currently calls `/api` on its own origin, so production deployments should normally reverse-proxy that path to NestJS. Cookies are `SameSite=Lax`, HttpOnly, and marked Secure in production.

Without the Resend key and sender, scheduling is rejected with a configuration error. The scheduler checks every 15 seconds while NestJS is running; Postgres claims due reminders atomically to avoid duplicate sends across instances.

## Verify

```powershell
pnpm test:unit
pnpm test:integration
pnpm build
```

## API overview

- `GET /api/health`
- `GET /api/health/supabase`
- `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- `POST /api/auth/password-reset`, `POST /api/auth/password-reset/confirm`
- `POST /api/auth/guest`, `POST /api/auth/transfer-guest`
- `POST /api/assistant/interpret` (requires `GEMINI_API_KEY`)
- `GET, POST /api/scheduled-actions`; `GET /api/scheduled-actions/:id`
- `GET, POST /api/tasks`; `GET, PATCH, DELETE /api/tasks/:id`; `PUT /api/tasks/reorder`
- `GET, POST /api/folders`; `DELETE /api/folders/:name`
- `GET, POST /api/tags`
- `GET, POST /api/notes`; `PATCH, DELETE /api/notes/:id`
- `GET, PUT /api/profile`
