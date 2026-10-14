-- Why a copy is in the trash: 'upgrade' (replaced_by names the new file) or
-- 'duplicate'. Empty for rows trashed before these columns existed.
ALTER TABLE trash_files ADD COLUMN reason TEXT NOT NULL DEFAULT '';
ALTER TABLE trash_files ADD COLUMN replaced_by TEXT NOT NULL DEFAULT '';
