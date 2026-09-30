# SamadhanAI authentication and verification setup

The backend uses SQLite at `.samadhan-auth/samadhan.sqlite` by default and applies schema migrations when it starts. Set `SAMADHAN_DATABASE_PATH` to move the database. Use Node.js 18 or newer.

## Contact OTP delivery

Both delivery providers must be configured before citizen registration or contact verification can complete. OTP values are sent only to the requested email/SMS provider, stored as keyed hashes, and are never returned by the API.

- Email: `SAMADHAN_RESEND_API_KEY` and `SAMADHAN_EMAIL_FROM`
- SMS: `SAMADHAN_TWILIO_ACCOUNT_SID`, `SAMADHAN_TWILIO_AUTH_TOKEN`, and `SAMADHAN_TWILIO_FROM`
- Set `SAMADHAN_OTP_SECRET` to a long, random, persistent secret so outstanding OTP hashes remain valid across restarts.

The independent mobile-only test flow is available at `/sms-otp.html` and uses `POST /api/otp/sms/request` plus `POST /api/otp/sms/verify`. It uses the Twilio variables above. If Twilio is missing or rejects delivery, the request returns an error and never exposes the generated OTP. Copy `.env.example` to `.env` and add real credentials there; `.env` is Git-ignored.

OTP codes expire after five minutes, allow five attempts, require a 60-second resend cooldown, and are limited to five requests per contact per hour.

## AI analysis

Set `GEMINI_API_KEY` to enable Gemini complaint analysis, including optional photo comparison and duplicate assessment. Without it, complaints remain in **Under Verification** with a rules-based category/priority suggestion for a human reviewer. GPS coordinates and nearby complaint reports are supporting context only; they do not prove a street-level issue.

## Department accounts and production

For local development, the server creates a department account and prints its generated login once. Configure `SAMADHAN_DEPARTMENT_EMAIL`, `SAMADHAN_DEPARTMENT_NAME`, and `SAMADHAN_DEPARTMENT_PASSWORD` to use a stable local account. Production startup requires `SAMADHAN_DEPARTMENT_PASSWORD`; use a strong unique value. Multiple accounts can be configured with `SAMADHAN_DEPARTMENT_ACCOUNTS` as a JSON array of `{ "email", "password", "department", "name" }` records; each password must be at least 12 characters.

Run with `NODE_ENV=production` behind HTTPS so the session cookie is marked Secure. Keep provider credentials and secrets in the host environment, not in frontend files or source control.
