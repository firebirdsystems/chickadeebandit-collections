# Collections

A [Chickadee Bandit](https://chickadeebandit.com) app.

Keep track of the things you collect: teddy bears, power tools, vinyl, anything. Photograph each item, tag it, and record where it is stored. Photos can have their background removed so each one shows the item alone.

## Features

- Any number of collections, each with its own items.
- Each item has a name, notes and the date it was acquired.
- Photos of each item. The first one is the item's picture in the grid.
- Background removal: a new photo is sent to the hub, which returns the same picture with the background made transparent. The photo as taken is always kept, and each photo has a switch back to it.
- Tags that belong to one collection ("Steiff", "Cordless").
- Places shared by every collection ("Garage", "Bin 1"), with a page per place listing everything stored there.
- Filter a collection by tag and place. Search by name, note, tag, place or the year it was acquired, in one collection or across all of them.
- A dashboard count of items collected.
- A share link for one collection: a read-only page anyone with the link can open.

## Background removal

The app declares the `image_cutout` capability and calls `files.cutout(fileId)` for each new photo in a collection that has "Remove the background from new photos" switched on (the default). It can also be asked for one photo at a time.

A household has a monthly allowance of cutouts, set by the hub. The hub keeps one cutout for a photo: making it spends one of the allowance, and asking again for the same photo returns the same file and spends nothing. The cutout belongs to its photo and is deleted with it.

The photo's row records where its cutout stands, so every tab and device shows the same thing and only one of them works on a photo at a time:

| `cutout_status` | Meaning | May be asked for |
|---|---|---|
| `none` | Not asked for | Yes |
| `pending` | Asked for; no answer written yet | No, until 5 minutes old |
| `done` | `cutout_file_id` holds it | No |
| `failed` | The hub could not make it | Yes ("Try again") |
| `quota` | The month's allowance is used up | Yes, next month |
| `unsupported` | The hub makes no cutout from this kind of picture (a GIF) | No |

A `pending` row older than five minutes is treated as failed, because the tab that asked may have closed before the answer came back.

A request is a hold on the row, stamped in `cutout_requested_at`. Photos wait in a queue, so the app renews its hold just before it asks the hub, and every later write names that stamp. If someone else has taken the photo in the meantime, or it has been deleted, the write changes nothing and the hub is not asked. When a cutout has already come back and its write changes nothing, the file is deleted only if the photo's row is gone or already names another cutout. If the row is still there and names none, whoever holds it now is handed the same file by the hub and writes it.

The hub makes a cutout from a JPEG, PNG or WebP photo. A picture of another kind is stored and never asked about: its row is `unsupported` from the start, and so is one the hub turns down for its kind (415).

Each cutout has a small copy for the grids, stored by a second request after the cutout comes back. When that request is refused or lost (a burst of new photos passes the hub's per-minute limit on file requests), the cutout is drawn whole. The app makes the copy up on a later visit: for the member's own photos it asks the hub for the cutout again, which returns the one it holds at no cost, a few a minute.

When the hub refuses for a reason that applies to every photo (the allowance is used up, the plan has lapsed, the service is unavailable, storage is full), the app says so once, stops asking for the rest of the visit, and keeps showing photos as taken.

## Who can do what

| | Whoever added it | An adult | Anyone else |
|---|---|---|---|
| See every collection, item, photo, tag and place | Yes | Yes | Yes |
| Start a collection; add an item, photo, tag or place | Yes | Yes | Yes |
| Change or delete it | Yes | Yes | No |
| Set the picture a shared page shows for an item | No, unless an adult | Yes | No |
| Delete a collection, with everything in it | Whoever started the collection | Yes | No |

Deleting a collection removes every item, tag and photo in it, including ones other members added. So a child who started a collection can delete it even after a sibling or a parent has added to it. Deleting an item works the same way one level down: it removes every photo of it, including photos other members added.

There are no private collections. Photo files are readable by every member of the household, so a collection that hid its rows would still expose its pictures.

The hub enforces this table through the `row_policies` in `manifest.json`. `scenarios.json` replays each rule, and every SQL statement the app sends, against the real runtime.

Deleting a collection deletes its items, tags and photos. Deleting an item deletes its photos. In both cases the hub reclaims the files: the photo, its thumbnail and its cutout.

## Sharing a collection

An adult can make a link to one collection from its page ("Share"). The link opens a read-only page, served by the hub, for anyone who has it. Links expire and can be revoked from the same panel. There is no link to every collection at once.

| On the shared page | Kept in the household |
|---|---|
| The collection's name and description | Tags |
| Each item's name, notes and acquired date | Where things are stored |
| One photo of each item | Who added what, and an item's other photos |

The page is live for as long as the link works: an item anyone in the household adds to the collection later appears on it, and so does a change to one already there.

The page lists the newest 200 items and shows up to 100 photos. Both are hub limits. A photo opens at full size from the page and carries the file name it was uploaded with. The hub removes location and camera details from JPEG, PNG and WebP photos when they are uploaded.

The hub reads an item's picture from a column on the item, and photos live in their own table. So each item carries `cover_file_ids`, a list holding the one file to show: its first photo, as the cutout when the item shows one. An adult's visit rewrites it whenever a photo is added, removed, cut out or switched, when the app is opened, and before the share panel opens. If that could not be done within a few seconds (the connection dropped, or a large household's first visit is still writing them), the panel says the page may show older photos, and the app tries again every half minute and whenever it is looked at. Only an adult writes it, of any item. The hub refuses anyone else (`row_policies.items.column_write_acls`), because whatever file the column names is served to anyone holding a link: left to an item's owner, a child could put any photo in the app on a shared page.

`cover_file_ids` is deliberately named in no file-reclaim key in the manifest. It is a second name for a file a photo row owns. Listed there it would count as a row still naming the file, and a deleted photo would stay stored, and public, until the copy caught up. As it is, a deleted photo is gone at once and a stale id on the item names nothing.

## Known limits

- A shared page's photos can lag the app: when a child changes the photos of an item, their own or anyone's, the page keeps the old picture (or none, if that photo was deleted, or the item is new) until an adult next opens the app. The item's name, notes and date are on the page at once.
- A write that changes no row (the row was deleted on another device) is reported, and every row is read again. A row added on this device in the moment that reading is on its way can be missing from view until the app is reloaded.
- Opened by someone the hub does not name as a member of the household, the app only shows: nothing can be added or changed.
- A cover is worked out from the rows a tab has loaded, and a tab does not see what other devices have changed since. So a tab left open does not bring the page up to date for changes made elsewhere, and pressing Share in it gives no warning about them. Reloading the app does.

- If the hub makes a cutout and its answer never arrives (the tab is closed, the connection drops), the photo reads as failed after five minutes. "Try again" then returns the cutout already made, at no cost.
- A request held by one device is taken as abandoned by another after five minutes, judged by each device's own clock. A device whose clock runs five minutes fast can take a request that is still live. Both then ask the hub, which makes one cutout and hands it to both.
- The hub lets an app keep 1,000 uploaded files, so 1,000 photos across all collections. A photo's small copy and its cutout are not counted. Past that the hub refuses new photos, and the app says so.
- A HEIC photo is stored as a JPEG, at up to 4,096 pixels on its longest side: the hub's upload redraws it in a browser that can read HEIC, and the hub converts one that arrives unread when it can. A photo that is still a HEIC after both is not kept, because only Safari shows one, the hub does not remove the location it carries, and no cutout can be made from it. A HEIC stored by an earlier version of the app keeps its location, and a shared page would serve it as it is.
- A photo added at the moment another member deletes its item can be stored with no item to show it. Its files stay until the app is removed.

## Development

```bash
make setup     # once: enables the pre-push hook
npm install
npm run build  # produces dist/bundle.json and validates the manifest
npm test
bash preflight.sh
```

`npm run dev` shows the app with sample data and no photos; uploads and cutouts need the hub.
