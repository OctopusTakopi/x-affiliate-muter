# X Affiliate Muter & Blocker

Adds `Mute all`, `Block all` and `Mute + Block all` to a company's Affiliates
tab on x.com.

## Install

1. Open `chrome://extensions` and turn on Developer mode.
2. Click "Load unpacked" and pick this folder.
3. Log into X, open a company profile, then the Affiliates tab.
4. The buttons appear above the list, with `Stop` and `Reset cap`.
5. After reloading the extension, refresh the X tab. Chrome leaves running
   content scripts alive with a dead `chrome.storage` binding.

## How it works

The list is virtualised, so a run scrolls it to the bottom and keeps every row
it passes. Steps are half a screen and overlap, and each waits only until the
rendered window changes. The walk ends once the scroller is at the end and three
more steps find no new account. Rows re-render and the position twitches there,
so neither counts. It also stops at 400 steps or 75 seconds.

Handles come from each row's profile link or avatar test id. The button carries
`<userId>-<state>`, so a row already in the requested state is skipped, since X
answers those with `400 already ...` and still charges budget.

Mutes and blocks go to X's v1.1 REST endpoints from your logged-in session:

    POST /i/api/1.1/mutes/users/create.json
    POST /i/api/1.1/blocks/create.json

`sniffer.js` runs in the page context, reads the session bearer off X's own API
traffic and hands it over by `postMessage`. Any script on the page can read it.

## Daily cap and permissions

400 requests per day, counted per HTTP attempt, kept in `chrome.storage.local`
and keyed by local date. `Mute + Block all` spends two per account, failures
included. `Reset cap` zeroes the counter after a confirmation, never mid-run.

`storage` holds that counter. `https://x.com/*` and `https://twitter.com/*` are
where the content scripts run. No background worker, remote code or analytics.

## Tests and packaging

    node test/manifest.mjs   # manifest and packaging wiring
    node test/harness.mjs    # behaviour, against a stubbed DOM
    sh build.sh              # stages dist/ and zips it
