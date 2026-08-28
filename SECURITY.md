# Security Policy

## Supported versions

Triastasis is alpha software. Security fixes are applied to the newest published alpha release and the current `main` branch. Older alpha builds are not supported after a replacement is published.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability and do not include exploit details, tokens, private file paths, model data, or user images in a public report.

Use GitHub's private vulnerability reporting form:

<https://github.com/dmelim/Triastasis/security/advisories/new>

If that form is unavailable, contact the repository owner through GitHub and request a private reporting channel without disclosing the vulnerability details publicly.

Include the affected Triastasis version, operating system, installation type, GPU backend, reproduction conditions, impact, and any suggested mitigation. Remove unrelated personal data from logs and attachments.

Ordinary bugs, crashes, compatibility problems, and model quality issues can use the public bug report template when they do not expose a security weakness.

## Scope

Security reports may cover the desktop application, native runtime, local automation API, installers, model downloader, update and release artifacts, or unsafe handling of local files. Vulnerabilities in an upstream dependency should also be reported to that upstream project when appropriate.
