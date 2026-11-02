# Changelog

## 0.2.0

### Added

- `/gauge on` and `/gauge off` show or hide the band for the session.

### Changed

- `/gauge` with no argument shows the status (on or off, the cache lifetime and the warning time) instead of toggling the band.

## 0.1.0

### Added

- A band above the prompt with the turn, output speed, turn and session cost, prompt cache countdown and context fill, drawn as chips with icons on the desktop.
- A toast and a notification when the prompt cache is about to expire (`cacheTtlMinutes`, `warnMinutes`).
