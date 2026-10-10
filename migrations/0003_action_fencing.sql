ALTER TABLE pending_actions ADD COLUMN fence_token TEXT;

ALTER TABLE processed_updates ADD COLUMN fence_token TEXT;
