# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

2AMetronome — a playlist-based metronome that runs entirely in the browser. Everything lives in `src/`
and is served as static files: no build step, no bundler, no dependencies (`package.json` exists only
as a placeholder with an empty `dependencies` block), no test suite, no linter.

## Running it

Serve `src/` over HTTP and open `index.html`. The repo defines no server command; any static server
works, e.g.:

```
python -m http.server 8000 --directory src
```

There is nothing to build, install, or compile. Editing a file and reloading the page is the whole
dev loop. Verification is manual, in a browser — check the console and exercise play/pause/stop,
next/prev, settings, and playlist upload.

## Architecture

`src/metro.js` is the entire application, ~900 lines, six classes, no modules — it is loaded with a
plain `<script>` tag and instantiates itself at the bottom (`let metro = new Metro(); metro.startup();`).
Classes are in one global scope and reference each other by name, so declaration order matters: `Song`
and `Playlist` come first because `Metro.NULL_SONG` is a `new Song(...)` in a static field initializer.

- **`Playlist`** / **`Song`** — the type definitions for the playlist JSON format (see below). Every
  playlist that is read — from a file, from `localStorage`, or from `MetroSettings.DEMO_PLAYLIST` — is
  turned into these classes immediately, so no other code touches raw JSON. The constructors apply the
  defaults and derive `index` / `durationInSeconds`; `validate()` is deliberately separate from the
  constructor, because `Metro.NULL_SONG` is a `Song` with `bpm: 0` and must not be validated.
- **`Metronome`** — audio engine only. Uses the standard Web Audio lookahead scheduler: a
  `setInterval` tick every `SCHEDULING_INTERVAL` (25 ms) schedules every beat falling within
  `SCHEDULE_AHEAD_TIME` (0.1 s) onto the `AudioContext` clock, so timing never depends on timer
  jitter. Tones are synthesized oscillators (`click` / `sine`), pitch is a frequency multiplier.
  It emits `callback(beat, bar, beatInBar, running)` per scheduled beat and knows nothing about
  songs or the DOM.
- **`Metro`** — application controller. Owns the playlist, the current song, DOM rendering, and a
  three-state machine (`stopped` / `paused` / `playing`) enforced in `setState()`, which throws on
  illegal transitions. Its `onBeatChange` is the `Metronome` callback and is where `autoStop` /
  `autoSilence` are applied.
- **`MetroSettings`** — persistence and the settings panel. Serializes the whole settings object
  (including the loaded playlist) to `localStorage` under the single key `settings` on every change,
  and notifies `Metro` via a `{property, value}` callback. Playlists are read client-side with
  `FileReader`; nothing is ever uploaded anywhere.
- **`DomUtil`** — small helpers, notably `toggleCssClass`.

A fresh `Metronome` is created per song start (`newMetronome`), and the previous one is `dispose()`d
so its `AudioContext` is closed — mobile browsers break if contexts accumulate; `scheduler()` has a
loop-detection guard for the case where `currentTime` never advances.

Views are plain DOM manipulation against ids in `index.html`; playlist rows are cloned from
`#playlistRowTemplate`, which is removed from the DOM at startup. There is no framework and no
templating, so an element id change must be made in both `index.html` and `metro.js`.

The JS and `metro.css` share an implicit CSS-class contract — the JS only toggles class names, the
stylesheet supplies all the visuals:

- `hidden` (`display:none !important`) and `disabled` (dimmed control buttons) are the universal
  show/hide and enable/disable mechanism, applied through `DomUtil.toggleCssClass`.
- `renderBeat` puts `first-beat` / `beat-0` / `beat-1` on `#metronome` — those are the flashing
  colors of the beat indicator.
- `now-playing` highlights the current playlist row.
- `muted` turns `#muteButton` red; the button is a CSS-only control (the letter M, no icon), sized and
  spaced from the settings icon through the `--menu-button-*` variables.

Silence has two independent sources, so `Metro` keeps `muted` (the user's `#muteButton`) apart from
`autoSilenced` (the current song's `autoSilence`) and pushes `muted || autoSilenced` into the audio
engine via `applyMuted()`. Collapsing them into one flag would let un-muting cancel an `autoSilence`
that is still in effect. Because a fresh `Metronome` is built per song start and starts unmuted,
`newMetronome()` has to re-apply — the user's mute outlives the instances, `autoSilenced` does not.

Layout is also split across both: `metro.css` has `orientation: portrait` / `landscape` media queries
(landscape puts metronome and playlist side by side), while `Metro.updatePlaylistMaxHeight()` computes
an inline `max-height` for `#playlistTableContainer` from `window.innerHeight` on startup and on every
`resize` / `orientationchange`. The landscape query deliberately neutralizes that inline value with
`max-height: unset !important`.

`#separator` between the two main containers is draggable (Pointer Events, so mouse and touch share
one code path) and resizes them. Neither container may become smaller than `Metro.SPLIT_MIN` (33 %) of
the size the app has on the device — `window.innerHeight` in portrait, `window.innerWidth` in landscape,
*not* a share of the two containers' own sizes. `clampSplitSize()` enforces that in pixels, and falls
back to an even split when both minimums do not fit (possible in a small desktop browser window).
Sizes are nonetheless persisted as fractions so they survive a window resize. `Metro.renderSplit(fraction)`
owns the inline sizes and always clears `width` *and* `height` on both containers before applying,
because the two orientations drive different properties and a leftover value would corrupt the other
one after rotation: portrait sets only `#metronomeContainer`'s height (the playlist follows in normal
block flow and is bounded by `updatePlaylistMaxHeight()`, which must therefore run *after*
`renderSplit`), landscape sets both widths so the flex items add up and nothing shrinks. The fraction
is persisted per orientation as `splitPortrait` / `splitLandscape`; `null` means "use the CSS", which
is what keeps the untouched first-run layout identical to the stylesheet's own sizes. Orientation is
read via `matchMedia('(orientation: portrait)')` and must stay in sync with the media queries. The
`pointer-events: none` on the grip icon is load-bearing: without it the `<img>` becomes the pointer
target and the browser starts a native image drag instead of a resize.

## Playlist format

The user-facing contract, documented in `src/howto-playlist.html` and exemplified by
`src/playlist.json` / `src/playlist-zwicky-b.json` / `MetroSettings.DEMO_PLAYLIST`. A playlist has a
`title` and a `songs` array; each song requires `title` and `bpm`, and may set `duration` ("m:ss"),
`autoStop` (bars), `autoSilence` (bars), and `info` (free text shown under the beat indicator). The
`Playlist` / `Song` classes are the single definition of the format — a change to it means touching
those classes, the how-to page, and the examples (the demo playlist doubles as the showcase).

`info` renders into `#songInfo`, stacked above `#songAutoInfo` inside `#songInfos`. The CSS gives it a
horizontal ellipsis and makes it the only shrinkable line, so when `#metronome` gets short the auto
stop / auto silence label survives and the info is squeezed away — that priority is a requirement, not
an accident.

Note that `src/playlist.json` also carries a top-level `countIn: true`, which nothing reads — it is an
open TODO, not a supported property.

## Known constraints in the code

`Metronome.BEATS_PER_BAR` is hard-coded to 4; the `measure` song property is defaulted to `4/4` and
stored, but never read.
`makeSineTone` ignores the scheduled `time` and plays immediately, so it is less accurate than
`makeClickTone`. Both are marked `TODO` in the source.

# Coding guidelines

- In JavaScript, use $ as a prefix for all variables holding a DOM object.
- In CSS, use CSS variables for shared colors, fonts and dimensions.

# Tools

We cannot run the Skill(claude-in-chrome), because it is denied by the administrator.