# Handy

A video player for language learners. **Touch anywhere on the video to pause**: no tapping first to show the controls and then hitting a small pause button. It shows one or two `.srt` subtitle files (for example German and Turkish) and works on iPhone, Android and computers.

**Open it:** https://indapentx.github.io/Handy/

Your videos and subtitles are opened straight from your device and never uploaded anywhere. The website only contains the player.

## Using it

1. Tap **Open video + subtitles** and select the video and its `.srt` file together. You can add a second `.srt` too.
2. Touch anywhere on the video to pause. Tap again to play.
3. While paused you get the seek bar, −5 s / +5 s, speed (0.5× to 1×, starting at 0.65×) and **CC**. CC shows one subtitle file, both at once, or none, and sets the text size.
4. The eye button at the top right hides every control, even while paused, so only the video and subtitles are left. Tapping still pauses and plays. **Hold** the dimmed lock button for a moment to bring the controls back.

If you pause just after a line has ended, it stays on screen for 2 seconds so you can still read it.

Handy remembers your place and the subtitles for every video. When you pick the same video again (for example after iOS reloaded the page), it continues where you stopped, with the subtitles already loaded.

### iPhone

- In Safari, tap **Share → Add to Home Screen** and open Handy from the home screen. It then runs full screen without the Safari bars, keeps the screen on while you watch, and works offline.
- The easiest way to get files onto the phone is an **iCloud Drive** folder (for example `Deutsch`). Put the videos and `.srt` files there on your Mac, and they show up in the iPhone Files app.

### Computer keys

| Key | Action |
| --- | --- |
| Space or K | Pause / play (clicking anywhere on the video works too) |
| ← → | Back / forward 5 seconds |
| S | Switch subtitles (first, second, both, off) |
| , and . | Slower / faster |
| F | Full screen |
| L | Hide / show the controls |

You can also drag the video and `.srt` files onto the page.

## Videos that won't play

iPhones play MP4 videos in H.264 or HEVC. MKV and WebM files, and AV1 or VP9 videos (common in YouTube downloads), may not play. AV1 only plays on iPhone 15 Pro and newer.

Download in H.264 with yt-dlp:

```bash
yt-dlp -S "vcodec:h264,res:1080,acodec:m4a" --merge-output-format mp4 URL
```

Or convert a video on a Mac with ffmpeg (uses the Mac's hardware encoder, so it's quick):

```bash
ffmpeg -i input.mkv -c:v h264_videotoolbox -b:v 6M -pix_fmt yuv420p -c:a aac -b:a 160k -sn -movflags +faststart output.mp4
```

## Development

Plain HTML, CSS and JavaScript with no build step and no dependencies.

```bash
python3 -m http.server 8000   # then open http://localhost:8000
npm test                      # subtitle parser tests (Node 20+)
```

- `srt.js`: reads subtitle files (UTF-8, UTF-16, old Windows-1252/1254 files, SRT and WebVTT) and finds the cue to show.
- `app.js`: the player: tap handling, subtitles, controls, saved positions.
- `sw.js`: offline copy of the app.

When you change the app, bump `CACHE` in `sw.js` so home-screen installs drop the old copy.
