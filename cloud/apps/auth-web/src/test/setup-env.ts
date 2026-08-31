// The unit suite's hermetic-environment guard, sibling of
// src/test/integration/setup-env.ts.
//
// cloud-ci.yml exports NEXT_PUBLIC_POSTHOG_KEY workflow-wide so that
// `next build` inlines it into the browser bundle. The test process inherits
// it there, which points captureServerException and the AI telemetry at the
// real PostHog project: CI unit runs would post $exception noise from
// deliberately-provoked errors, and any test that mocks fetch sees capture
// calls it never asked for (turnstile.test.ts was the first casualty).
// Tests that exercise the capture path set the key themselves (log.test.ts);
// everyone else runs keyless, the same as a local checkout.
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
