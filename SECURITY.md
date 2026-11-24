# Security

## Reporting a vulnerability

Please do not put the details of a security problem in a public issue, pull
request or discussion.

Report it privately with GitHub's private vulnerability reporting: on this
repository, **Security → Report a vulnerability**
(<https://github.com/FrameOS/frameos/security/advisories/new>). Only the
maintainers see the report, and the fix can be worked on there before it is
public.

If that button is not offered, open an issue that says only that you have a
security report and how to reach you, with no details in it.

What helps in a report: what is affected (the self-hosted backend, FrameOS
Cloud, the runtime on a Raspberry Pi, the ESP32 or Pico firmware, the iOS
app), the version or commit, and the steps that show it.

## Supported versions

Fixes go into the next release; older releases are not patched. What is
supported is the [latest release](https://github.com/FrameOS/frameos/releases/latest):
its backend image, its runtime for Raspberry Pi frames and its ESP32 and Pico
firmware. FrameOS Cloud (cloud.frameos.net) is deployed from `main`.
