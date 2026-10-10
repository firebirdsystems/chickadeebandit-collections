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

## Background removal

The app declares the `image_cutout` capability and calls `files.cutout(fileId)` for each new photo in a collection that has "Remove the background from new photos" switched on (the default). It can also be asked for one photo at a time.

A household has a monthly allowance of cutouts, set by the hub. Each request the hub accepts spends one, and a second request for the same photo makes a second file. So the photo's row records where its cutout stands, and the app asks only when that record allows it:

| `cutout_status` | Meaning | May be asked for |
|---|---|---|
| `none` | Not asked for | Yes |
| `pending` | Asked for; no answer written yet | No, until 5 minutes old |
| `done` | `cutout_file_id` holds it | No |
| `failed` | The hub could not make it | Yes ("Try again") |
| `quota` | The month's allowance is used up | Yes, next month |

A `pending` row older than five minutes is treated as failed, because the tab that asked may have closed before the answer came back.

A request is a hold on the row, stamped in `cutout_requested_at`. Photos wait in a queue, so the app renews its hold just before it asks the hub, and every later write names that stamp. If someone else has taken the photo in the meantime, or it has been deleted, the write changes nothing: the hub is not asked, or a cutout that has already come back is deleted instead of being left with no row to name it.

When the hub refuses for a reason that applies to every photo (the allowance is used up, the plan has lapsed, the service is unavailable), the app says so once, stops asking for the rest of the visit, and keeps showing photos as taken.

## Who can do what

| | Whoever added it | An adult | Anyone else |
|---|---|---|---|
| See every collection, item, photo, tag and place | Yes | Yes | Yes |
| Start a collection; add an item, photo, tag or place | Yes | Yes | Yes |
| Change or delete it | Yes | Yes | No |
| Delete a collection, with everything in it | Whoever started the collection | Yes | No |

Deleting a collection removes every item, tag and photo in it, including ones other members added. So a child who started a collection can delete it even after a sibling or a parent has added to it. Deleting an item works the same way one level down: it removes every photo of it, including photos other members added.

There are no private collections. Photo files are readable by every member of the household, so a collection that hid its rows would still expose its pictures.

The hub enforces this table through the `row_policies` in `manifest.json`. `scenarios.json` replays each rule, and every SQL statement the app sends, against the real runtime.

Deleting a collection deletes its items, tags and photos. Deleting an item deletes its photos. In both cases the hub reclaims the files: the photo, its thumbnail and its cutout.

## Known limits

- If the hub makes a cutout and its answer never arrives (the tab is closed, the connection drops), that cutout is spent and its file is left with no photo naming it. "Try again" then spends another. The hub keeps no record of which cutout came from which photo, so the app cannot recover it.
- A request held by one device is taken as abandoned by another after five minutes, judged by each device's own clock. A device whose clock runs five minutes fast can take a request that is still live, and one photo then costs two cutouts.
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
