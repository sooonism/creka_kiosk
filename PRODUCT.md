# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Guests at live events scan a QR code on their phone and leave a message (text, photo or short video). The organiser (event planner, company marketing team, couple or host) moderates and chooses how the event looks. Venue staff put the wall on a big screen or projector. Clients: corporate events and conventions first, then private events (weddings, birthdays).

## Product Purpose
Lovewall (`/lovewall/<campaign-slug>`) collects guest messages and shows them live on a venue screen. It is one part of creka-kiosk, backed by creka_backend (`/api/v1/lovewall/:slug`). Success: guests post in seconds on a phone, and the screen looks like it belongs to that event.

## Positioning
A wall the organiser can dress as their own event (template, title, logo, accent colour) without a designer, run from one organiser page with moderation built in.

## Operating Context
Guest page: phone, plain QR scan, often dim venue light, one hand. Wall: projector or large display at distance, left running for hours, video with sound after one click. Organiser: OTP login on `/lovewall/<slug>/organiser`, moderation queue plus settings (mode, blocklist, pause).

## Capabilities and Constraints
- One template themes both guest page and wall. Four templates: Classic (current look), Corporate, Elegant, Festive.
- Organiser customises per event: template, event title + subtitle, logo/header image, accent colour.
- Template choice and branding are stored per campaign in the backend lovewall settings (`campaigns.config["lovewall"]`); logo needs upload storage in creka_backend.
- Message kinds: text, photo, video (max 15s default). Text length and moderation rules come from the backend.

## Evidence on Hand
Existing components: `src/components/LovewallSubmit.svelte`, `LovewallWall.svelte`, `LovewallOrganiser.svelte`. No client logos, testimonials or brand assets are provided; do not fabricate them.

## Product Principles
- The event's name and brand lead; the product recedes.
- Readable at distance and in the dark.
- Guest posting stays under ten seconds.
- Organiser setup works without design skill.
