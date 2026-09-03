# Security

FreshCtx reads source code from the local workspace and keeps exact historical
revisions under `.freshctx/` until `freshctx clean` is run. Treat that directory
as sensitive code data. It is added only to `.git/info/exclude`; FreshCtx never
edits the workspace `.gitignore`.

The service accepts only relative regular UTF-8 files below the supplied
workspace root. It rejects symlinks, path traversal, binary files, unstable
snapshots, and files larger than 512 KiB. These controls reduce accidental
exposure; they are not a substitute for OS permissions, disk encryption, or a
security review of a bridge.

FreshCtx rechecks paths and file metadata around each read, but Node's portable
filesystem API cannot make a pathname walk immune to a hostile local process
continuously swapping parent directories. Run it only in a workspace that
untrusted local users cannot modify. Concurrent ordinary editor writes are
retried once and otherwise omitted as unstable snapshots.

Run it as a local, single-user process. Do not expose its stdio protocol as a
network service or send its archive to an untrusted system.

To report a vulnerability, contact the maintainer privately with a minimal
reproduction. Please do not include proprietary source code in the report.
