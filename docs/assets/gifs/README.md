---
name: artwork-gif-provenance
title: Provenance for the profile artwork GIFs
type: provenance
version: v1
status: final
description: Source, authorship, hosting basis, checksums, and citation templates for the three self-hosted artwork GIFs.
contributors:
  - name: KS
    type: human
    model: unknown
    role: original-author-and-publisher
  - name: Capy
    type: ai
    model: openai/gpt-6-luna
    role: checksum-verification-and-documentation
created: 2026-11-27
updated: 2026-11-28
tags:
  - provenance
  - artwork
  - animated-gif
requires: []
provides:
  - artwork-source-records
  - sha256-checksums
applies_to:
  - ksouth/ksouth/docs/assets/gifs/
authorship_note: Prepared by Capy from KS's instructions and supplied files; all three downloaded files were checked against the supplied byte counts and SHA-256 hashes.
---

# Profile artwork GIF provenance

All three files below were downloaded fresh from the artists' Tumblr posts on 2026-11-27, then copied byte for byte. Their byte counts and SHA-256 values match the values KS supplied. No file was resized, retimed, recompressed, or otherwise changed.

The Krystal South and Kevin Bewersdorf GIFs have zero-millisecond frame delays in the original bytes. Ben Aqua's frames have 80-millisecond delays. These timings are recorded as supplied; they have not been edited.

Tumblr source URLs are intentionally omitted here at KS's request. Each source is recorded as “artist's Tumblr post.” The visible citations are in the profile README. Titles remain plain italic text, not links; the artist names link to the artist pages. If KS later asks to remove an artwork image, remove only the image and keep its citation.

## *I can feel you googling me*

- **Artist:** Krystal South.
- **Work/date:** Animated gif. November 2013. The Western Digital pavilion, curated by Rick Silva for The Wrong Biennale.
- **File:** `krystal-south-googling-me.gif` — 500×500 pixels, 6 frames, 131,794 bytes.
- **SHA-256:** `3654da9edb0f0463019ede080af750663ba254aa9dd5907c5f96012dabe32926`.
- **Source:** Artist's Tumblr post; URL intentionally omitted.
- **Hosting basis:** Krystal South's own work, hosted at KS's direction as the artist and rights-holder.
- **Related citation links:** Krystal South — https://krystalsouth.com/ ; Rick Silva — https://ricksilva.net/ ; The Wrong Biennale, 2013–14 — https://thewrong.org/2013-14 . All three returned HTTP 200 to an automated request on 2026-11-27.
- **Date link:** None. KS directed that “November 2013” remain plain text.

Profile caption:

```html
<img src="docs/assets/gifs/krystal-south-googling-me.gif" width="500" alt="I can feel you googling me by Krystal South">
<sub><em>I can feel you googling me</em>, <a href="https://krystalsouth.com/">Krystal South</a>, Animated gif. November 2013. The Western Digital pavilion, curated by <a href="https://ricksilva.net/">Rick Silva</a> for <a href="https://thewrong.org/2013-14">The Wrong Biennale</a>.</sub>
```

## *Maximum Sorrow*

- **Artist:** Kevin Bewersdorf.
- **Work/date:** Animated Gif. 2008-2009.
- **File:** `kevin-bewersdorf-maximum-sorrow.gif` — 500×300 pixels, 22 frames, 53,619 bytes.
- **SHA-256:** `5aba58b63680b30ccbd3dd9ec154e53420206c6a40c6d142330f3d765847becc`.
- **Source:** Artist's Tumblr post; URL intentionally omitted.
- **Hosting basis:** Hosted at KS's direction. KS says she is the archivist of Bewersdorf's work and has his written permission to host it.
- **Related citation links:** Kevin Bewersdorf — https://www.kevinbewersdorf.org/ ; *Maximum Sorrow* archive page — https://www.kevinbewersdorf.org/websites/maximumsorrow/index.html . Both returned HTTP 200 to an automated request on 2026-11-27. The archive page is a related/source link for provenance, not a title link in the profile caption.

Profile caption template:

```html
<img src="docs/assets/gifs/kevin-bewersdorf-maximum-sorrow.gif" width="500" alt="Maximum Sorrow by Kevin Bewersdorf">
<sub><em>Maximum Sorrow</em>, <a href="https://www.kevinbewersdorf.org/">Kevin Bewersdorf</a>, Animated Gif. 2008-2009.</sub>
```

## *Never Log Off*

- **Artist:** Ben Aqua.
- **Work/date:** 2013.
- **File:** `ben-aqua-never-log-off.gif` — 463×665 pixels, 12 frames, 96,899 bytes.
- **SHA-256:** `e6867f92487dcc895530339be7cdd55d235168aa42321d216d90ecbc3486d1df`.
- **Source:** Artist's Tumblr post; URL intentionally omitted.
- **Hosting basis:** Hosted at KS's direction. KS supplied the exact file and requested that the artwork be credited with its artist, title, and year.
- **Related citation links:** Ben Aqua — https://benaqua.org/info ; Etsy shop — https://www.etsy.com/shop/b3naqua . The artist page returned HTTP 200 and the Etsy shop returned HTTP 403 to automated requests on 2026-11-27. The Etsy link is provenance only, not a title link in the profile caption.

Profile caption template:

```html
<img src="docs/assets/gifs/ben-aqua-never-log-off.gif" width="463" alt="Never Log Off by Ben Aqua">
<sub><em>Never Log Off</em>, <a href="https://benaqua.org/info">Ben Aqua</a>, 2013.</sub>
```

The three images are stacked at their native widths, with each caption immediately below its image. The profile README embeds the repo-stats and commit-graph cards. The languages card remains an unembedded option.
