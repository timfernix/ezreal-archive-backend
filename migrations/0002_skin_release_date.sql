ALTER TABLE skins ADD COLUMN release_date TEXT;
UPDATE skins SET release_date = CAST(release_year AS TEXT) WHERE release_year IS NOT NULL;
