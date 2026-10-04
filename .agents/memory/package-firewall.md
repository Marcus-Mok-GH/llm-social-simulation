---
name: Package firewall recovery
description: Replit's package firewall blocked an older transitive tar archive during workspace installation.
---

When a workspace install is blocked on `tar@7.5.11`, check the current registry version and update the root pnpm override rather than bypassing the firewall. The checked latest version was `7.5.22`, and using it allowed installation to complete.

**Why:** The package firewall returned HTTP 403 for the older transitive tarball even though a newer version was available.

**How to apply:** Recheck the current latest version before updating the override again; do not assume the recorded version stays current.