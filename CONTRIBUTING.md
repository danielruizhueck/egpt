# Contributing to eGPT

Every clone is a node, and every code change a node makes flows back upstream as
a pull request. That is the default, not an extra step: an agent working in a
clone opens the PR itself once a chunk is verified. Nobody has to ask for it.

Upstream: <https://github.com/danielruizhueck/egpt>


## The flow (agents do this without being asked)

1. **Branch.** Never commit on `main`. One branch per concern, named
   `<node_name>/<topic>` (e.g. `em/listening-reaction`).
2. **Work the loop in [`CLAUDE.md`](CLAUDE.md) §6**: reproduce-first test, full
   suite, commit per chunk with specific `git add` (never `add -A`).
3. **Fork once** if you can't push upstream: `gh repo fork --remote` (your fork
   becomes `origin`, this repo becomes `upstream`).
4. **Push and open a DRAFT PR** against upstream `main`:
   `gh pr create --draft --repo danielruizhueck/egpt --base main`.
   - Title: the chunk's commit summary.
   - Body: what / why, the reproduce-first test, suite totals before and after.
     Name every pre-existing failure so a reviewer can tell it from a new one.
5. **One concern per PR.** More work on the same concern → push to the same
   branch. A different concern → a new branch and a new PR.
6. **Humans decide.** A person marks the PR ready and merges. Agents never
   merge, never push to `main`, never force-push a branch someone else pushed.


## What never goes in a PR

- Anything from the profile (`~/.egpt`, or `EGPT_HOME`): `config.yaml`,
  conversations, transcripts, media, state.
- Tokens, keys, phone numbers, chat ids, or names from a live node. Tests use
  fakes.
- Machine-local paths (`/Users/<you>/…`, `C:\Users\<you>\…`).


## Platform changes

eGPT was built and run on Windows first. A fix for macOS or Linux must leave
Windows behavior byte-identical — behind `process.platform` or an opt-in config
leaf — and ship with a test that runs on any OS.
