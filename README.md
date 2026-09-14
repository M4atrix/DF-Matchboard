# DF Matchboard

Delta Force community match archive, leaderboard, and team splitter.

This repository contains the website ready for GitHub Pages. Publish the main branch from the root folder.

## Features
- Browse four supplied matches and their original screenshots.
- View player statistics and cumulative standings.
- Read lobby screenshots locally with bundled English OCR.
- Generate balanced teams and assign squads manually.
- Add matches and export a JSON backup.

## Data storage
New matches and changes are saved only in the current browser. Visitors do not share a live database. Use the download button to back up your data. Uploaded screenshots are processed in your browser.

## Hosting
All website files are in the repository root. Keep the JavaScript, images, OCR models, and WebAssembly files together. No build step or backend is required.

OCR works best with Latin player names; review extracted names before generating teams.
