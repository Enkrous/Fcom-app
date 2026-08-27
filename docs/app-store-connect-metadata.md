# App Store Connect Metadata Draft

This repository is currently a vanilla HTML/CSS/JS SPA backed by Supabase Edge Functions. It does not contain an iOS project, Xcode workspace, native bundle identifier, screenshots, or App Store Connect automation. Do not treat this file as a submission artifact until a native wrapper or separate iOS project exists.

## Product

- Name: Fcom Messenger
- Category: Social Networking
- Audience: school community members after account moderation
- Primary language: Russian UI in the current SPA

## Short Description

Fcom Messenger helps approved school community members chat, join school/private groups, rate recent interactions through Credo, and use safety controls such as reports and blocks.

## Keywords

school messenger, private groups, student community, moderation, chat, reputation, safety

## Privacy And Safety Notes

- Accounts require moderation before full access.
- Direct writes go through Supabase Edge Functions.
- `service_role` is server-only and must never be shipped to the frontend.
- Users can report another approved same-school user.
- Users can block/unblock direct peer contact.
- Admins can review open reports in the Admin tab.
- `supabase/seed.sql` is local/dev only and must never be run against production.

## Native Gaps Before Submission

- Create or choose an iOS/native wrapper project.
- Confirm bundle id, signing, icons, launch screen, and screenshots.
- Map web auth/session storage behavior to the native container.
- Complete App Privacy labels from the production data inventory.
- Run a production security review for Supabase env vars, RLS/grants, and storage policies.
