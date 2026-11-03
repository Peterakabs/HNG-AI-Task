# Google sign-in and Google Calendar setup

Spectre keeps its existing NestJS session cookie. Supabase's browser client is used only to complete Google OAuth and link Google Calendar access. Calendar refresh tokens are encrypted by the backend before they are stored.

## Google Cloud

1. Select the Spectre Google Cloud project.
2. Open **APIs & Services → Library**, search for **Google Calendar API**, and click **Enable**.
3. In **Google Auth Platform → Data Access**, add the read-only scope `https://www.googleapis.com/auth/calendar.events.readonly`.
4. Keep the OAuth app in **Testing** and add your own Google account as a test user while setting up. For general public use, complete Google's consent-screen verification when required.
5. Keep the existing Web OAuth client. Its Supabase callback URI should be `https://lgseazfkoqaozavyozno.supabase.co/auth/v1/callback`. Include the deployed Vercel origin and local Vite origin as authorized JavaScript origins.

## Supabase

1. In **Authentication → Providers → Google**, enable Google and save the Web client ID and secret.
2. In Authentication configuration options, enable **manual identity linking**. Spectre links Calendar authorization to the signed-in Supabase user with `linkIdentity`; it does not create a separate calendar user.
3. In **Authentication → URL Configuration**, set the Site URL to `https://hng-ai-task-frontend.vercel.app` and allow that URL plus `http://localhost:5173` as redirect URLs.
4. Run `supabase/migrations/202611030001_google_calendar_connections.sql` in the Supabase SQL Editor. The connection table is service-role-only and stores the Google refresh token encrypted.

## Environment variables

In **Vercel → Project → Settings → Environment Variables**, add these to Production and Preview (and Development if desired):

```text
VITE_SUPABASE_URL=https://lgseazfkoqaozavyozno.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<Supabase publishable/anon key>
```

In **Render → Spectre backend → Environment**, add:

```text
GOOGLE_OAUTH_CLIENT_ID=<the Web OAuth client ID>
GOOGLE_OAUTH_CLIENT_SECRET=<the Web OAuth client secret>
GOOGLE_TOKEN_ENCRYPTION_KEY=<64 hex characters>
```

Generate the encryption key in PowerShell:

```powershell
[Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

Use the same Google Web OAuth client ID and secret saved in Supabase. Keep the secret and encryption key on Render only; never put them in Vercel or source control. Redeploy both Vercel and Render after adding variables.

## Use it

Open Spectre, sign up or log in, then open **Profile → Connect Google Calendar** and approve read-only calendar access. Google Calendar events appear in Spectre's Calendar view. When a newly created task has a due time within 30 minutes of an event, Spectre asks whether to create the task anyway. **Cancel** returns to the task form; **Create task anyway** proceeds.

This uses only the `calendar.events.readonly` scope, which permits listing event details and is a sensitive Google scope. A Google OAuth app in Testing is limited to its configured test users. See [Supabase Google OAuth setup](https://supabase.com/docs/guides/auth/social-sign-in/auth-google), [Supabase identity linking](https://supabase.com/docs/guides/auth/auth-identity-linking), and [Google Calendar scopes](https://developers.google.com/workspace/calendar/api/auth).
