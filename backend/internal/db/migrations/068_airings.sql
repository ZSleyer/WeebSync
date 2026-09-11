-- What the providers said would air, kept once it has. Their schedules only
-- ever look ahead - AniList hands out notYetAired slots, TMDB's season fetch is
-- filtered to the future - so the calendar had nothing at all to show for the
-- days just gone. The sweep copies every slot it sees here; the list endpoint
-- reads back the past week.
CREATE TABLE airings (
  source    TEXT    NOT NULL,
  media_id  INTEGER NOT NULL,
  airing_at INTEGER NOT NULL,
  episode   INTEGER NOT NULL, -- absolute, as the provider counts: a watch's own offset is applied on read
  -- Keyed on the episode, not on the time: anime gets pushed back all the time,
  -- and a slot that moved is the same episode at a new time, not a second one.
  -- Two episodes airing the same day - TMDB dates by day, not by time - are two
  -- rows, which is what the key says as well.
  PRIMARY KEY (source, media_id, episode)
) WITHOUT ROWID;
