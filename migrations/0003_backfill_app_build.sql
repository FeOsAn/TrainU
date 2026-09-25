-- An install that already has goals was built before the survey existed.
-- 0002 created app_build empty, so every such install opened on the survey,
-- and finishing it duplicated every goal. Mark it built. Idempotent: only
-- when goals exist and no build row does.
INSERT INTO app_build (id, completed_at, answers_json, updated_at)
SELECT 'self', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '{}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM goals) AND NOT EXISTS (SELECT 1 FROM app_build WHERE id = 'self');
