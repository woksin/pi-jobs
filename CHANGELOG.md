# Changelog

## 0.5.0

### Added
- Opt-in `quietTimeouts` silently re-arms empty watch timeout periods under the same id, preserving the change baseline and overall deadline across same-process reload. Watches wake on a match, an inconclusive check at a period boundary, or the final timeout.
- Quiet watch snapshots expose re-arm counts and the overall deadline; timeout notifications report the number of periods.

## 0.4.0

### Added
- Opt-in inbox subscriptions retain matched results until receipt and pause consuming checks when retained-message limits are reached.
- Declared inbox subscriptions prevent duplicate consumers within one process and respect parked lanes.

### Fixed
- Preserve captured subscription results across owner shutdown and reload handoff.

## 0.3.1

### Fixed
- Missing or incompatible reload handoffs report each affected item's full command and recorded settings in both the UI and session/model context, rather than only a generic UI warning. Legacy runtimes that already stopped their work cannot be resurrected; compatible owners remain adoptable across code updates, including snapshots without the optional watch interval field.

## 0.3.0

### Added
- Registry snapshots now include the configured watch `intervalSeconds`, alongside existing `label`, `until` and `timeoutSeconds` fields. Plain commands have no watch interval or until condition.

## 0.2.0

### Added
- Jobs and watches survive `/reload`. The new session takes over the old session's running jobs and watches and still gets their completion notices. The handoff is bounded, and job ownership is checked before adoption.
- Watches have their own per-session cap (32), separate from the cap on commands (8). Override the caps with `PI_JOBS_MAX_RUNNING` and `PI_JOBS_MAX_WATCHES`.

### Changed
- CI now tests against Pi 1.3.0.

## 0.1.0

- First release.
