-- Collections: things a household keeps, grouped into collections, each with
-- photos, tags and the places it is stored.
--
-- Every table carries `visibility`, fixed to 'everyone' by a CHECK. The row
-- policy on each table (`owner_or_visibility`, see manifest.json) reads it: the
-- whole household sees every row, the member who added a row may change it, and
-- so may an adult. There is no private collection, because the photo bytes are
-- readable by any member of the household whatever the row says.
--
-- Migrations are additive only: add 002_*.sql for later changes.

CREATE TABLE IF NOT EXISTS app_collections__collections (
  id          TEXT NOT NULL PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- 1: a new photo in this collection has its background removed.
  auto_cutout INTEGER NOT NULL DEFAULT 1,
  visibility  TEXT NOT NULL DEFAULT 'everyone' CHECK (visibility = 'everyone'),
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- A tag belongs to one collection: "Steiff" means nothing among the power tools.
CREATE TABLE IF NOT EXISTS app_collections__tags (
  id            TEXT NOT NULL PRIMARY KEY,
  collection_id TEXT NOT NULL,
  name          TEXT NOT NULL,
  visibility    TEXT NOT NULL DEFAULT 'everyone' CHECK (visibility = 'everyone'),
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

-- A location is shared by every collection: the garage holds tools and bears.
CREATE TABLE IF NOT EXISTS app_collections__locations (
  id         TEXT NOT NULL PRIMARY KEY,
  name       TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'everyone' CHECK (visibility = 'everyone'),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_collections__items (
  id            TEXT NOT NULL PRIMARY KEY,
  collection_id TEXT NOT NULL,
  name          TEXT NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  -- The day it joined the collection, as yyyy-mm-dd. NULL when not recorded.
  acquired_date TEXT,
  -- JSON arrays of tag ids and location ids. Filtering happens in the app over
  -- rows it already holds, so these are never compared in SQL.
  tag_ids       TEXT NOT NULL DEFAULT '',
  location_ids  TEXT NOT NULL DEFAULT '',
  visibility    TEXT NOT NULL DEFAULT 'everyone' CHECK (visibility = 'everyone'),
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- One row per photo. `file_id` is the picture as taken and is never replaced.
-- `cutout_file_id` is the same picture with its background removed, made by the
-- hub on request. The hub keeps no record of which cutout came from which
-- photo, so `cutout_status` is the only account of where a cutout stands:
--   none     not asked for
--   pending  asked for at `cutout_requested_at`; no answer written yet
--   done     `cutout_file_id` holds it
--   failed   the hub could not make it; may be asked for again
--   quota    the household's cutouts for the month are used up
CREATE TABLE IF NOT EXISTS app_collections__photos (
  id                  TEXT NOT NULL PRIMARY KEY,
  collection_id       TEXT NOT NULL,
  item_id             TEXT NOT NULL,
  file_id             TEXT NOT NULL,
  thumb_file_id       TEXT,
  cutout_file_id      TEXT,
  cutout_status       TEXT NOT NULL DEFAULT 'none',
  cutout_requested_at TEXT,
  -- 0: show the photo as taken even though a cutout exists.
  use_cutout          INTEGER NOT NULL DEFAULT 1,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  visibility          TEXT NOT NULL DEFAULT 'everyone' CHECK (visibility = 'everyone'),
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL
);

-- The app pages through items and photos newest first.
CREATE INDEX IF NOT EXISTS app_collections__items_created_idx
  ON app_collections__items (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS app_collections__photos_created_idx
  ON app_collections__photos (created_at DESC, id DESC);
-- Deleting a collection or an item removes its children by these columns.
CREATE INDEX IF NOT EXISTS app_collections__items_collection_idx
  ON app_collections__items (collection_id);
CREATE INDEX IF NOT EXISTS app_collections__tags_collection_idx
  ON app_collections__tags (collection_id);
CREATE INDEX IF NOT EXISTS app_collections__photos_item_idx
  ON app_collections__photos (item_id);
CREATE INDEX IF NOT EXISTS app_collections__photos_collection_idx
  ON app_collections__photos (collection_id);
