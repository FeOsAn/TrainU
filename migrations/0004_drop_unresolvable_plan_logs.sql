-- GET /api/plan/arbitrate logged the whole plan on every page load as a row
-- nothing could ever resolve (no outcomeId was returned). A single row from a
-- far-future goal date could be hundreds of MB, and the calibration report
-- read every row on every pacing request. The route no longer writes them.
DELETE FROM outcome_log WHERE kind = 'plan:arbitration';
