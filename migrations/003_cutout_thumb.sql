-- A small copy of a photo's cutout, for the shelf and the grids: made in the
-- browser from the cutout the hub hands back, kept by the hub beside it, and
-- transparent like it. NULL until a cutout is made, when none could be kept,
-- and for every cutout made before this column: the cutout itself is drawn.
--
-- Written after `cutout_file_id`, and only onto a row that names that cutout.
-- The hub removes it with the cutout whether or not a row names it.
ALTER TABLE app_collections__photos ADD COLUMN cutout_thumb_file_id TEXT;
