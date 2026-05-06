# uz_shots_uploader

Standalone FiveM resource that uploads the entire `uz_AutoShot/shots/` folder to
[Fivemanage](https://fivemanage.com/) via the v3 base64 file endpoint, preserving
the exact subfolder structure on the remote side.

This is a separate resource — it does **not** modify `uz_AutoShot`.

## How it works

1. Recursively walks `<resource cache>/uz_AutoShot/shots/**`.
2. For each `.png` / `.webp` / `.jpg` / `.jpeg` / `.mp4` / `.mp3` / `.wav` / `.ogg`,
   POSTs to `https://api.fivemanage.com/api/v3/file/base64` with:
   - `base64`: file bytes, base64-encoded
   - `filename`: original file name
   - `path`: `<remote prefix>/<relative folder>` so structure is preserved
3. Records the resulting CDN url in `output/uploaded.json`.
4. Re-runs skip files already in the manifest, so it's safe to resume after a
   crash, restart, or rate-limit.

## Install

Drop `uz_shots_uploader/` next to `uz_AutoShot/` in your `resources` folder and
add to `server.cfg`:

```cfg
ensure uz_shots_uploader

# required
set fivemanage_api_key "YOUR_FIVEMANAGE_API_KEY"

# optional — defaults shown
set uz_shots_source_resource "uz_AutoShot"
set uz_shots_source_subdir   "shots"
set uz_shots_remote_prefix   "uz_autoshot"   # remote root folder on fivemanage
set uz_shots_delay_ms        "150"           # gap between requests
set uz_shots_max_retries     "3"

# allow yourself to run the command
add_ace identifier.license:YOUR_LICENSE command.uploadshots allow
```

## Commands

Run from the server console (or as an ACE-allowed player):

| Command | What it does |
|---|---|
| `uploadshots` | Start (or resume) uploading `shots/**` to Fivemanage. |
| `uploadshots_status` | Print counts of uploaded / failed / running. |
| `uploadshots_reset` | Clear `uploaded.json` + `failed.json` so the next run re-uploads everything. |

## Output

After a run, you get:

- `output/uploaded.json` — `{ "<rel/path/file.png>": { url, originalUrl, id, remotePath, size, uploadedAt } }`
- `output/failed.json` — last error per file that failed (empty when all succeed).

Folder layout on Fivemanage matches the local layout, e.g.

```
shots/male/2/0.png       ->  uz_autoshot/male/2/0.png
shots/male/prop_1/3.png  ->  uz_autoshot/male/prop_1/3.png
shots/vehicles/adder.png ->  uz_autoshot/vehicles/adder.png
```

(Set `uz_shots_remote_prefix ""` to drop the prefix and mirror exactly.)

## Notes

- Uses Node.js built-ins only (`fs`, `path`, `https`) — no `npm install` step.
- Each successful upload writes the manifest every 10 files (and on exit), so an
  interrupted run loses at most ~10 entries of progress.
- Failures are retried up to `uz_shots_max_retries` times with linear backoff
  before being recorded in `failed.json`.
