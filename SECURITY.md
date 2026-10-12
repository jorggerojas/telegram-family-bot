# Security Policy

## Supported versions

Security fixes apply to the default branch of this repository.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

Email the maintainer privately (see the GitHub profile for contact details), or
use [GitHub private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) if enabled on this repository.

Include:

- A clear description of the issue and impact
- Steps to reproduce (proof of concept if available)
- Whether you have already tested against a live deployment

You should receive an acknowledgement when possible. Please give a reasonable
window before any public disclosure.

## Scope notes

This project is designed for a **private allowlisted Telegram bot** backed by
one Google Calendar. Misconfiguration (public calendar ACL, leaked secrets,
open allowlist) is outside the application’s control and should be reported as
an operational issue when you discover it in a shared deployment.
