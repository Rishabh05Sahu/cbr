-- Phase 3 slice 8, corrective pass (owner approval 2026-10-29, review finding M1; ADR-0014):
-- an interaction stores a fingerprint of the whole normalised submission it came from, so a
-- repeated submission with the same idempotency key is accepted as "already saved" only when
-- every input that can change a side effect is identical (channel, direction, outcome, times,
-- notes, confirmations, contact status details, requirement changes and follow-up details).
-- A different submission with the same key is a conflict instead of a silent success.
--
--   interaction.request_fingerprint   SHA-256 (hex) of the canonical submission, computed by the
--                                      application (src/modules/interactions/fingerprint.ts). A
--                                      digest only: no second copy of the request or its personal
--                                      data. The idempotency key is part of the hashed input, so
--                                      equal submissions under different keys do not share a
--                                      digest. NULL only on rows logged before this migration
--                                      (they cannot be verified and are treated conservatively).
--
-- Earlier migrations are not changed; existing rows are kept as they are.

ALTER TABLE interaction ADD COLUMN request_fingerprint TEXT;
ALTER TABLE interaction
  ADD CONSTRAINT interaction_request_fingerprint CHECK (request_fingerprint IS NULL
    OR request_fingerprint ~ '^[0-9a-f]{64}$');

-- Every new row carries one (rows from before this migration keep NULL).
CREATE FUNCTION app.interaction_fingerprint_required() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.request_fingerprint IS NULL THEN
    RAISE EXCEPTION 'an interaction needs its request fingerprint' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.interaction_fingerprint_required() FROM PUBLIC;
CREATE TRIGGER interaction_fingerprint_required BEFORE INSERT ON interaction
  FOR EACH ROW EXECUTE FUNCTION app.interaction_fingerprint_required();
