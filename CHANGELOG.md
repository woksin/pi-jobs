# Changelog

## Unreleased

- Registry snapshots now include the configured watch `intervalSeconds`, alongside existing `label`, `until` and `timeoutSeconds` fields. Plain commands have no watch interval or until condition.

## 0.2.0

### Added
- Jobs and watches survive `/reload`. The new session takes over the old session's running jobs and watches and still gets their completion notices. The handoff is bounded, and job ownership is checked before adoption.
- Watches have their own per-session cap (32), separate from the cap on commands (8). Override the caps with `PI_JOBS_MAX_RUNNING` and `PI_JOBS_MAX_WATCHES`.

### Changed
- CI now tests against Pi 1.3.0.

## 0.1.0

- First release.
