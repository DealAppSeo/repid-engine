ALTER TABLE trinity_artifacts
  ADD CONSTRAINT trinity_artifacts_has_content_or_location CHECK (
    filename IS NOT NULL 
    OR file_path IS NOT NULL 
    OR external_url IS NOT NULL 
    OR content_preview IS NOT NULL
  ) NOT VALID;
