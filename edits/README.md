# Edit requests (from the site's edit mode)

The site's edit mode (`?edit` + password) sends requests to `api/edits.js`, which commits each one here as
`edits/<id>/request.json` plus any uploaded images (`img-N.webp`). **Nothing on the live site changes by itself.**

Claude, at the start of each session:
1. Look for folders here whose `request.json` has `"status": "pending"`.
2. Review every change: no medical content in the industrial catalog, spelling, image quality/framing.
   Raise anything doubtful with Royi before applying.
3. Apply: hide → remove/flag in the data constants; text → update the constants; images → convert to WebP,
   rename, place under `assets/`, wire into the data.
4. Set `"status": "done"` (plus `"applied_in": "vNNN"` and notes) in `request.json`, delete the uploaded
   originals once converted, bump `APP_VER`, commit and push.

`change.type`: `hide` | `unhide` | `text` (`he`/`en`, `was`) | `image` (replace `target` src with `file`) | `add` (add `file` to gallery `target`).
Commits that only touch `edits/` don't redeploy the site (`ignoreCommand` in `vercel.json`); `.vercelignore` keeps this folder off the site.
