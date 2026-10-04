-- DayMarket package catalog seed (DayMarket's own packages; business_id null = operator-fulfilled).
-- Run in the Supabase SQL editor after migration-orders-v1.sql. Idempotent via name.
-- Prices in cents, from the approved package strategy (priced by attendance, not by the dozen).

insert into public.dm_packages (business_id, name, description, serves_min, serves_max, base_price_cents, active) values
  (null, 'Huddle Box', '5–10 people: one premium branded box blending standard favorites with high-end savory items, napkins and branded flavor labels. Small teams, interview panels, board meetings.', 5, 10, 8900, true),
  (null, 'Meeting Box', 'Donuts sized to expected attendance. The baseline — every meeting, every week.', 10, 15, 9900, true),
  (null, 'Morning Meeting', 'Donuts plus brewed coffee. The default way to start a workday meeting.', 10, 15, 12900, true),
  (null, 'Birthday Box', 'Donuts with balloons. The easiest win on the menu.', 5, 15, 5900, true),
  (null, 'Executive Boardroom', '12–20 people: sweet, savory, and premium pastries arranged symmetrically, plus an integrated premium coffee and beverage station. Company updates, client pitches.', 12, 20, 19900, true),
  (null, 'Employee Appreciation', '25–40 people: premium assortment, beverages, individual packaging. White-glove breakroom setup with tiered display stands. Specialty fritters and a full breakfast sandwich spread.', 25, 40, 38900, true),
  (null, 'Monthly Workplace Plan', 'Scheduled recurring delivery. The standing order that makes revenue predictable. Custom-quoted.', 10, 200, null, true)
on conflict do nothing;
