<!-- first-pass:machine:start v0.8.1 (written by the setup-first-pass skill from this machine's survey; it describes this machine only and never goes in a file teammates share; re-run setup to refresh it, and put your own notes outside the markers) -->

## This machine (first-pass)

- **Machine:** {{machine}}
- **Heavy runs** (databases, browsers, emulators, media tools, full builds): {{heavy_runs}}
  This answer applies in every project on this machine, and it never covers a local run that
  reaches real people (email, SMS, push, payments, publishing to real accounts): that run asks
  first, unless it runs with the keys and switches its repo's section lists set, setting them
  stops it, and the section does not say it needs a yes; and a repo whose "Local runs that
  reach real people" line says "unknown", that has no such line, or that has no first-pass
  section asks before a server, a worker or an end-to-end or integration run.
- **Limits and cleanup:** {{limits}}
- **Looking at a UI running:** {{ui_tools}}
- Each repo's section says what its heavy runs and UI checks are; this block says how this
  machine runs them. A line in a repo's section written on another machine (a `.ps1` runner,
  a `C:\` or `$LOCALAPPDATA` path, `taskkill`) is read through this block.

<!-- first-pass:machine:end -->
