# CamRally

*(Note: the underlying Firebase project is still named `multicam-app` — Firebase project IDs can't be renamed after creation, and the live URL is `multicam-app.web.app`. This only affects the technical config below, not what appears in the app itself.)*

A phone-based multi-camera recording tool. One person starts a session and gets a
5-character code. Other phones join as either a **Camera** (records) or a
**Controller** (picks which camera records, reviews takes, sees the shared album).

Clips are sent **directly phone-to-phone** the moment you tap Save — they never
touch a server. When everyone leaves the session, every clip is gone. No cloud
storage, no billing, no account required beyond the free Firebase project you
already set up.

## What's in this folder

- `index.html`, `css/style.css`, `js/app.js`, `js/firebase-config.js` — the app itself
- `firebase.json`, `.firebaserc` — hosting config, already pointed at your `multicam-app` project
- `firestore.rules` — production-ready rules for the small signaling data
  (session codes, camera names/status) — this is the only thing stored in the
  cloud, and it's automatically deleted when the controller ends the session

## Deploy it (one-time setup)

You need Node.js installed on your computer for this part — everything after is just
opening a link on your phone.

1. Open a terminal in this folder.
2. Install the Firebase CLI (only needed once, ever):
   ```
   npm install -g firebase-tools
   ```
3. Log in:
   ```
   firebase login
   ```
4. Deploy:
   ```
   firebase deploy
   ```
5. It prints a **Hosting URL** — something like `https://multicam-app.web.app`.
   That's the link you share.

To push future changes, run `firebase deploy` again from this folder.

## How the shared album actually works

- Cameras and the controller open a direct connection to each other (using a
  free public "matchmaking" service called PeerJS, just to help phones find
  each other — no video ever passes through it).
- Once connected, saved clips are sent straight from camera to controller,
  and the controller relays them to every other camera too — so everyone in
  the session sees the same album on their own phone.
- Nothing is written to a database or a server. If a phone closes the tab or
  loses connection, its clips are only gone from *that* phone's copy of the
  album — clips already relayed to others stay put until they leave too.
- **Works best when every phone is on the same WiFi.** Direct connections
  can occasionally fail to establish across separate cellular connections
  because of how mobile carriers handle networking — there's no free way
  around that. If that happens, the clip still saves locally on the
  recording phone; it just won't show up on the others.

## Using the app

**Starting a session**
1. Open the site, tap **New session**. You'll get a 5-character code.
2. Tap **Controller** on the phone that should direct the shoot, or **Camera** if
   this phone is one of the cameras.
3. Share the code with the other phones — they tap **Join session**, enter it, and
   pick **Camera**.

**Controller layout**
- Two tabs at the top: **Recording** and **Feed**.
- **Recording** tab has a dropdown to pick how cameras are controlled:
  - **Manual** — every camera is independent. Start/stop/review each one on its own. Good for running several angles at once and picking the best takes afterward.
  - **Swap** — only one camera is "live" at a time. Tap another camera to cut to it instantly — the outgoing camera auto-saves its clip with no retake prompt, and the new one starts recording right away. Good for switching angles live during a single continuous scene.
  - **Simultaneous** — one "Turn on all" / "Turn off all" button controls every connected camera together, all at once. The simplest option when you just want everyone rolling or stopped together.
  - The camera grid and the shared album both live under this tab.
- **Feed** tab shows the live video preview described below.

**Live feed** (Feed tab, controller only)
- Shows a real live video preview — not just a status dot — of whichever camera is currently recording.
- One camera recording → its feed fills the space automatically.
- Multiple cameras recording at once → a dropdown appears letting you pick one specific camera, or "All cameras" to see every live feed at once in a grid.
- No camera recording → shows a placeholder.
- This is a live picture-only preview (muted, no audio) sent directly from each camera phone — same peer-to-peer connection used for clips, nothing recorded or stored from it.

**Save all**
- Both the controller's album and each camera's own album (tap the 🎞 button, top right of the camera view) have a "Save all" button.
- Downloads every clip currently in that album straight to the phone/computer's downloads, one after another. Handy for grabbing everything at the end of a session before it disappears.

**Recording (Simultaneous mode)**
- Each camera phone shows a live preview and waits.
- On the controller, each connected camera shows up as a card with a **Record**
  button. Tap it to start that camera; the button becomes **Stop**.
- When stopped, the camera phone shows a preview of the take with **Retake** or
  **Save to album**. Retake discards it. Save sends it out immediately — it
  appears in the album on the controller and every other camera.
- Camera phones have their own **Album** button (top right) to view what's
  been saved so far, including clips other cameras took.
- You can run multiple cameras recording at the same time — each is independent.

**Ending a session**
- The controller's power icon (bottom right) ends the session for everyone —
  all cameras get bumped back to the home screen, and everything is cleared.
- A camera's own power icon just leaves that one phone; the session keeps
  going for everyone else.

## Notes / current limits

- No live video preview streaming to the controller — you see status
  (ready / recording / reviewing) but not a live feed from each camera.
- Recording format depends on the phone's browser (Chrome/Android records
  WebM, Safari/iOS records MP4) — both play fine in the album.
- A camera drops off the controller's grid after ~15 seconds of no heartbeat
  (e.g. if it loses signal or the tab is closed unexpectedly).
