# The Reddit launch clip and the README GIF

One recording, framed twice: a square (1080 px) clip for phones, and a wide
(1280 x 720) GIF for the README, `docs/demo.gif`. Each is framed: the camera zooms in on the master
or a card, with a short caption per beat. Same made-up world as the other
demos (`scripts/demo/README.md`), with the `reddit` timeline and chat turns in
`scenario.ts`.

1. Slack fills NEEDS YOU; the newest asks for a fix.
2. Tab to it: "Start new session fix-csv-export".
3. `y` starts it; it files itself under orders db and its answer becomes a reply to Priya.
4. `@new create a fix for the dto validation of purchase endpoint`.
5. `@fix-csv-export message Priya on Slack when you're done`.
6. `x` clears NEEDS YOU as the camera pulls out to the whole, calm map.
7. An end card: the logo, the name, the tagline and getserenity.dev.

Captions sit in a band under the view, in serenity's green (#7fc77f).

From the repo root (needs vhs, tmux, bun, ffmpeg, gifsicle and uv):

```bash
vhs scripts/demo/reddit/reddit.tape                          # out/raw.mp4, 2950 x 1610
uv run --with pillow python scripts/demo/reddit/frame.py         # out/reddit.mp4 and out/reddit.gif
uv run --with pillow python scripts/demo/reddit/frame.py readme  # docs/demo.gif
```

`frame.py` holds the parts of the recording kept and how fast each plays
(`SEGMENTS`), the camera moves (`shots`) and the captions (`CAPTIONS`), all in
seconds of `out/raw.mp4`; each profile sets its own size and camera views. The tape waits on the screen, so after
re-recording check those times against its frames.
