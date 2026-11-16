-- UAE phone numbers for property contacts (owner decision 2026-11-16: customers are in Dubai;
-- lead and contact numbers may be UAE or Indian). Lead phones were never constrained to a country
-- in the database; property contacts were (0025). This widens that CHECK to the same two
-- shapes the application accepts (src/modules/leads/normalise.ts):
--   +971 then a mobile (5 + 8 digits) or a fixed line (area code 2/3/4/6/7/9 + 7 digits)
--   +91 then an Indian mobile (6-9 + 9 digits), as before.
-- Existing rows all match the old, narrower rule, so none is invalidated. No existing migration
-- is rewritten.

ALTER TABLE property_contact DROP CONSTRAINT property_contact_phone;
ALTER TABLE property_contact
  ADD CONSTRAINT property_contact_phone CHECK (phone_e164 IS NULL
    OR phone_e164 ~ '^\+971(5[0-9]{8}|[2-46-79][0-9]{7})$'
    OR phone_e164 ~ '^\+91[6-9][0-9]{9}$');
