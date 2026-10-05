# DayMarket Architecture Audit — October 4, 2026

## The doctrine (his words, distilled)

- A business profile is a **digital twin** — not a listing, but the best version of the business.
- A business's **existence** can be engineered like a birthday: word spread, good experiences, pleasant relationships — then people come, and they bring others, and they gift. Holidays are engineered the same way.
- This becomes the business's existence **in an age of speculation and gossip**. Every business deserves that.
- **The Michelin pattern**: people came for tires, got a map of the best eats; the map became the guide. People come to DayMarket to avoid the kitchen and get a deal (times are hard) — and they get the holiday. The deal is the tire; the holiday is the map.
- **Consumers** come for: avoiding the kitchen (daily load), deals (life is expensive), and the **gift-feel** (a holiday feels like receiving a gift). Holidays get shaped around the business's runtime, calendar, and inventory — turning stock, cutting waste, raising profit.
- **Organizations** come because they're carrying the load of productivity, mental health, growth, and culture-through-meetings/events. Having that managed is **hosting a birthday for them**: a holiday culture inside their business, around their calendar, their employees' appreciation, their meetings, their events.
- **The flywheel**: orgs land → their calendars create recurring demand → orders route to profiled businesses → businesses want profiles (DayMarket is the AI-assisted sales desk they don't have) → the roster deepens the trust layer → consumers trust the marketplace.
- **The trust layer** is the businesses with profiles (cf. vets + universities for Dog Is Human).

## What's sound (keep)

- **Supabase schema** (`dm_` tables in the readable project): clean, RLS correct, public-read on active businesses/published holidays/active offers. The core loop — businesses → holidays → offers → redemptions — matches the doctrine.
- **Auth + dual dashboards** (member/business) live on the subdomain.
- **Intake → OSN Airtable**, CORS-correct, subdomain holds no secret.
- **Existence layer, partially built**: newsroom (live feed + posts), WhatsApp community (Deal Alerts + Columbia Crew, invite wired), newsletter template, LinkedIn company page.
- **Deploy pipeline**: working source → mirror → atomic Netlify deploys.

## Gaps (in build order)

### 1. Public business profiles — THE missing surface
There is no public per-business page and no business directory. Profiles exist only inside the owner's dashboard — invisible. Against the doctrine, this is fatal: the twin has no face, the Michelin guide has no pages, the trust layer can't compound.
**Build**: `/businesses/[slug]` public profile pages + a public directory. Profile = story, photos, signature items, live holidays, redemption proof. RLS already allows public read of active businesses.

### 2. Richer profile fields (twin depth)
Current fields: name, slug, tagline, description, logo, website. A "best version of themselves" needs: address, hours, phone, photo gallery, signature items, story, **slow periods** (feeds future AI holiday suggestions). Schema migration required. Keep everything structured data, not blobs — the AI reasons over it later.

### 3. Org workspace (the demand engine)
Orgs are currently just `pass_type='organization'` on a member row. The flywheel needs: an org dashboard with **their calendar** (recurring packages, appreciation moments, meetings, events), package ordering, and fulfillment routing to profiled businesses. This is the biggest missing piece.

### 4. Fulfillment loop (supply engine)
When an org orders, the order must route to a profiled business; the business sees it in their dashboard (orders/fulfillment view alongside the redemptions table). Tables needed: `dm_orders` (org → business → package → scheduled date → status).

### 5. AI-assisted holiday suggestions (later)
Suggest holidays from slow days + inventory signals. Requires gap #2's data first (hours, slow periods). The "engineered birthday" becomes semi-automatic.

### 6. Gifting (later)
Gift a claim to someone else. Matches the gift psychology directly. Small schema addition (`gifted_to` on redemptions or a gift table).

## Architecture principles (hold these)

1. **Profiles are public by default.** The twin exists to be seen. RLS already does this — don't regress it.
2. **Structured over free-text.** Every twin attribute the AI will later reason over (hours, slow days, signature items, capacity) must be a field, not a paragraph.
3. **The calendar is the demand engine; fulfillment is the supply engine; the profile is the trust surface.** Every build should serve one of the three.
4. **Consumer gift-feel is a UX requirement**, not copy: claiming should feel like receiving, not transacting.
5. **One community per business** (standing): DayMarket's WhatsApp community is the first; VictoryLap, Readable, etc. get their own.
6. **Pricing discipline: a discount is only real if a markup funds it.** Holiday member prices are dual-funded — the business sets the promotional price (their call, their margin) and DayMarket's cut applies to the transaction. Never advertise a discount neither side holds. (15% is Ellianna's specific deal; other merchants default to profile fee + membership.)
7. **True menu only.** Items and prices come from the menu we built, never DoorDash or directories. In-store prices on everything.

## Standing decisions referenced
- $235 non-member minimum; $35 small-order fee; Holiday Pass $12/mo; Org membership $49/mo; Business profile $99/mo (all but the first two still adjustable).
- Stripe products for DayMarket not yet created (needs granular approval).
- Nothing sends without his go (outreach, newsletter).
