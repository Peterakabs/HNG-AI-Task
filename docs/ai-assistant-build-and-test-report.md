# Spectre AI Assistant: Build and Internal Test Report

## Product direction and authorship

I defined the product requirements for the Spectre assistant through detailed prompts, follow-up corrections, and acceptance directions. The implementation follows those instructions; the assistant behavior and scope were not independently invented by the engineering implementation.

My directions specified that the assistant should:

- Help create personal reminders and scheduled email reminders through a voice-first conversational flow.
- Use Gemini for AI interpretation instead of OpenAI, with the model configurable through `GEMINI_MODEL`.
- Keep the microphone conversation open across multiple turns, so I can provide or correct details without repeatedly tapping Speak.
- Collect reminder details, resolve date/time in the user's timezone, preserve a draft between turns, and ask for explicit confirmation before creating or scheduling anything.
- Keep ordinary reminders available to guest users while requiring authentication for email reminders.
- Stop listening and speaking when I close the assistant, and stop/cancel an action that is still in progress.
- Avoid sending an email reminder immediately; email reminders must go through the existing scheduled-action flow.

These product prompts and directions are the source of the requirements summarized in this report.

## How the assistant is built

### Browser conversation

The React assistant panel in `frontend/src/main.jsx` uses browser speech recognition to capture speech and speech synthesis to read responses. Recognition stays in continuous mode. After a spoken phrase ends, the UI sends that turn for interpretation, speaks the response, and resumes listening automatically while the conversation remains active.

The UI stores the recent conversation and current draft in session storage. It also keeps live references to the latest draft, messages, and authentication state so the long-running microphone callbacks use current conversation data rather than an older render.

### AI interpretation

The frontend sends each turn to `POST /api/assistant/interpret`. The NestJS controller in `backend/src/app.controller.ts` associates the request with the current guest or authenticated identity and delegates to `VoiceAssistantService` in `backend/src/voice-assistant.service.ts`.

The service sends a bounded transcript, recent conversation, draft, local date/time, and timezone to Gemini. `GEMINI_MODEL` selects the model; the current fallback is `gemini-3.8-flash`. Gemini returns structured intent and reminder fields. The backend validates those fields, checks required information and future time, preserves fields during corrections, and returns the next clarification or confirmation summary.

The model does not create tasks or send email. The application performs those actions only after it receives a valid confirmation for a complete draft.

### Creating the reminder

- A confirmed personal reminder is created through the existing `POST /api/tasks` endpoint.
- A confirmed email reminder is created through the authenticated `POST /api/scheduled-actions` endpoint. Its delivery is handled later by the scheduled-action worker and existing email provider configuration.
- A guest who requests an email reminder is sent through the existing account gate; the reminder draft remains available through that flow.

### Closing the assistant

Closing the modal cancels browser speech and recognition, aborts an in-flight interpretation request, and prevents a late interpretation response from continuing the conversation. If a task or scheduled-action creation request was already submitted, the UI waits for its response and then attempts to delete the task or cancel the scheduled action. This cleanup avoids reporting a successful action after the modal has closed.

## Internal testing performed

I added Playwright browser tests in `e2e/assistant.spec.cjs`, with configuration in `playwright.config.cjs`. The tests run the local React app in Chromium, mock the API responses, and simulate speech recognition and speech synthesis.

| Scenario | Result |
|---|---|
| Speak a reminder, receive a confirmation question, say “Yes, do it,” and verify the current draft is sent and the task is created | Passed |
| Close the assistant while task creation is in flight and verify the created task is deleted and no success speech is produced | Passed |

**Result: 2 Playwright tests passed.** The tests were run against the local Vite app on November 2, 2026.

## Test scope and limits

The Playwright tests use mocked API responses and simulated browser speech. They validate the React conversation flow, confirmation handling, and modal-close cancellation behavior. They do not validate a live Gemini response, a real microphone or speech engine, Supabase persistence, authentication against the production project, or Resend email delivery.

The tests do not claim that the live external services or production email-reminder flow were exercised. Backend unit and integration tests are separate from these Playwright browser checks.

## Running the browser tests

Install dependencies and Chromium once:

```powershell
pnpm install
pnpm exec playwright install chromium
```

Start the frontend in one PowerShell window:

```powershell
pnpm --filter @spectre/web dev --host 127.0.0.1
```

Run Playwright from a second PowerShell window at the repository root:

```powershell
pnpm test:e2e
```

