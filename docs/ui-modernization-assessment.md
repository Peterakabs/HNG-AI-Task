# Spectre UI modernization assessment

## Current architecture

- The client is React 19 with Vite and a shared application stylesheet. It does not use Tailwind or shadcn/ui today.
- Shared controls already exist (`AppButton`, `TextInput`, `Modal`, `PasswordField`), so new UI should use those rather than replacing working flows.
- The current color, typography, and theme variables support light and dark modes. Mobile navigation and modal breakpoints are already present.
- Impeccable's context loader was attempted, but its local engine is not installed and the restricted session cannot write to its cache. The available `impeccable` and `better-layout` guidance was read and applied directly.

## Module-by-module assessment

| Module | Decision | Focus |
| --- | --- | --- |
| Dashboard and task overview | Polish | Preserve the current task-first layout; improve loading, network, and retry feedback. |
| Task creation and editing | Polish | Keep the existing form and make the post-save reminder step immediate. |
| Checklist | Polish | Keep existing interactions; use shared controls and retain touch-size targets. |
| Task collaboration | Enhance | Preserve owner/editor/viewer behavior; keep permission and request feedback clear. |
| AI task assistant | Polish | Retain the conversation flow and make loading/error feedback consistent. |
| AI notes assistant | Polish | Retain dictation and rewriting; use the existing recording and transcription states. |
| Calendar and Google integrations | Polish | Preserve integrations, add clear connection states, and keep conflict confirmation contextual. |
| Personal reminders | Enhance | Use backend scheduling, saved inbox items, timezone-aware times, and optional browser push. |
| Email and phone reminders | Preserve | Keep unavailable delivery channels labeled Coming Soon; no provider or paid service is activated. |
| Notifications | Redesign | Use a dedicated, grouped inbox and explicit notification preferences. |
| Profile and photo management | Polish | Keep upload preview/confirmation and use consistent settings controls. |
| Authentication and onboarding | Polish | Preserve guest access and provide a direct sign-in recovery path for expired sessions. |
| Settings and integrations | Enhance | Add notification controls while keeping Google and account settings in place. |

## Incremental implementation sequence

1. Establish shared feedback states, recovery copy, and accessible notification presentation.
2. Move task reminders to the existing server scheduler and persistent inbox; add optional Web Push.
3. Refine individual feature screens in separate passes, checking existing interactions in both themes and at mobile/tablet widths.

This pass completes steps 1 and 2. A wholesale shadcn conversion was avoided because it would require introducing Tailwind and replacing the existing shared controls before the current interfaces have been reviewed module by module. The current custom controls and CSS tokens are the compatible foundation for incremental modernization.

## Browser push setup

Push is opt-in and only appears enabled after both client permission and backend subscription storage succeed. Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` on the backend. Generate an ephemeral P-256 pair with Node:

```powershell
node -e "const c=require('node:crypto');const e=c.createECDH('prime256v1');e.generateKeys();console.log('VAPID_PUBLIC_KEY='+e.getPublicKey().toString('base64url'));console.log('VAPID_PRIVATE_KEY='+e.getPrivateKey().toString('base64url'))"
```

Use the `mailto:` subject for a real support address. Keep the private key only in Render's backend environment. Apply `supabase/migrations/202611090001_persistent_task_notifications.sql` before deploying the API. Browser push is best-effort; reminders remain in the inbox if push delivery is unavailable.
