ALTER TABLE processed_updates ADD COLUMN lease_until INTEGER;

UPDATE processed_updates
SET lease_until = updated_at + 60000
WHERE status = 'processing' AND lease_until IS NULL;
