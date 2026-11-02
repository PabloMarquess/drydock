# Changelog

## 0.2.0

### Added

- `/bulkhead` shows the guard: on or paused, the confirm style, custom rules and disabled rules.
- `/bulkhead off` (or `pause`) turns the guard off for the session, taken only when the person types it; `/bulkhead on` (or `resume`) turns it back on. A status line shows while it is off.

## 0.1.0

### Added

- A guard for the Bash tool: blocks catastrophic commands and stops risky ones for a person to run or confirm, across Terraform and OpenTofu, Kubernetes and Helm, destructive AWS CLI calls, git history rewrites and `rm -rf` outside the project.
