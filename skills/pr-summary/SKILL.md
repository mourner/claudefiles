---
name: pr-summary
description: Draft a concise pull-request summary or release note for a branch or diff. Focuses on the crux of the change, verifies claims against the diff, and outputs a draft for review (never posts).
---

# PR summary

**Produce a draft for the user to review — never post it.** No `gh pr
create`/`edit` or issue/PR comments unless asked after seeing the draft.

Default to the current branch against its merge base (usually `main`); ask only
if that's ambiguous.

- **Read the diff first** (`git diff <base>...HEAD`) — write from what actually
  changed, not from memory or the branch name.
- **Describe the net change vs base, not the journey.** Summarize the final diff,
  not the steps taken to get there — skip intermediary fixes that only make sense
  relative to an earlier work-in-progress state, not vs `main`.
- **Lead with the crux: the why and the impact.** Group changes at a high level;
  don't enumerate every minor edit (renames, moved lines, incidental cleanup).
  A reviewer should get the point from the first line or two.
- **Compact and plain.** Short declarative sentences, no marketing language, no
  emoji, no filler sections. Match the repo's existing PR/changelog style.
- **Don't assert what you haven't checked.** Every claim should trace to a real
  change in the diff. Numbers you already measured this session are fine to reuse
  as long as no later change invalidated them — only re-measure when something
  affecting them changed. Sizes in decimal KB (1000-based).
