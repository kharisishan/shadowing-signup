CREATE TABLE IF NOT EXISTS claims (
  id    TEXT PRIMARY KEY,   -- slot id, e.g. 7th-october-putra-lights-9-am
  name  TEXT NOT NULL,
  token TEXT NOT NULL,      -- anonymous per-browser token, lets a volunteer release their own slot
  at    TEXT NOT NULL
);
