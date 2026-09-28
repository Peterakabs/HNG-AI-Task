# Spectre

Spectre is a task and notes app with a React frontend and NestJS JSON API.

## Requirements

- Node.js 20 or later
- pnpm 11 or later

## Run locally

```powershell
pnpm install
pnpm dev
```

The React app runs at `http://localhost:5173`; Vite proxies `/api` calls to NestJS at `http://localhost:3000`. Guest tasks are scoped to a browser-generated device ID. Account data is scoped to the authenticated account. The API stores task data and auth records in JSON files under `backend/.data` by default. Configure `SPECTRE_DATA_FILE` and `SPECTRE_AUTH_FILE` to choose their paths.

## Authentication and email reminders

Normal task use is available as a guest. Signup and login use email plus password; passwords are hashed with scrypt and sessions are signed, HttpOnly cookies. Scheduled actions require an account. Guest data from the legacy JSON store is assigned to the first device that opens the upgraded app, and signup copies that device's task data into the account.

Email delivery uses SendGrid's v3 Mail Send API because the existing app did not have an email provider. Set these backend environment variables to enable delivery:

- `SENDGRID_API_KEY`
- `EMAIL_FROM` (a verified sender address)
- `APP_URL` (the public app URL used by reminder links)
- `SPECTRE_SESSION_SECRET` (required in production; use a long random secret)
- `APP_NAME` (optional; defaults to Spectre)

Without the SendGrid key and sender, scheduled reminders are marked failed when due. The scheduler checks every 15 seconds while the NestJS process is running. The current JSON-file store is intended for a single API instance with persistent disk; use one backend instance so workers do not compete to claim email actions.

## Verify

```powershell
pnpm test:unit
pnpm test:integration
pnpm build
```

## API overview

- `GET /api/health`
- `GET, POST /api/tasks`; `GET, PATCH, DELETE /api/tasks/:id`; `PUT /api/tasks/reorder`
- `GET, POST /api/folders`; `DELETE /api/folders/:name`
- `GET, POST /api/tags`
- `GET, POST /api/notes`; `PATCH, DELETE /api/notes/:id`
- `GET, PUT /api/profile`
