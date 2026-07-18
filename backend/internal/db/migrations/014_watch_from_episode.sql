-- Count only episodes at/after this number for the watch's file tally, so a
-- part that shares a season folder with earlier parts (Dr. Stone S4 Part 3
-- from E26, Conan S33 from E31) reports its own episode count. 0 = count all.
ALTER TABLE watches ADD COLUMN from_episode INTEGER NOT NULL DEFAULT 0;
