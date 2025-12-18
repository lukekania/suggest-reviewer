# Suggest Reviewer

Reviewer Suggester is a GitHub Action that automatically suggests reviewers for pull requests based on real repository signals, not guesses.

It answers one simple question:

Who is most likely to review this PR quickly and competently?

The action posts (or updates) a single comment on the pull request with suggested reviewers and short explanations.

## Problem

Choosing reviewers is inefficient:
- Ownership is unclear or outdated
- Engineers over-mention or hesitate
- Review latency varies wildly
- The same decisions are repeated on every PR

GitHub already has the data needed to make reasonable suggestions, but it is not connected.

## What the Action Does

On pull request events, the action:
1. Inspects the files changed in the PR
2. Analyzes recent commit history
3. Applies CODEOWNERS rules (if present)
4. Factors in historical review latency (optional)
5. Ranks likely reviewers using heuristics
6. Posts or updates one PR comment with suggestions

The action is deterministic, heuristic-based, and never blocks merges.

## Example Output

Reviewer suggestions
- @alice (score: 14 — CODEOWNERS, recent commits)
- @bob (score: 9 — fast reviewer, recent commits)
- @carol (score: 6 — recent commits)

Confidence: High

## Usage

```yaml
name: Reviewer Suggester

on:
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  suggest-reviewers:
    runs-on: ubuntu-latest
    steps:
      - name: Suggest reviewers
        uses: lukekania/suggest-reviewer@v0.1.0
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

## Configuration

| Input | Default | Description |
|------|---------|-------------|
| max_reviewers | 3 | Maximum number of reviewers |
| lookback_days | 90 | Commit history lookback |
| max_files | 50 | Max changed files |
| use_codeowners | true | Boost CODEOWNERS |
| use_latency | true | Boost fast reviewers |
| latency_prs | 20 | PRs sampled for latency |

## Ranking Signals

- Commit history on changed files
- CODEOWNERS matches
- Median historical review latency

A confidence level (High / Medium / Low) is derived from signal strength and score separation.

## Design Principles

- Zero configuration to get value
- Heuristics over ML
- One comment updated in place
- Explanations over black boxes

## Known Limitations

- Heuristic-based and imperfect
- Latency sampling is approximate
- API rate limits on very large PRs

## Possible Future Features

- Review load awareness
- Cross-repo expertise detection
- Reviewer preferences / opt-out
- Team-level suggestions
- Required-reviewer integration
- Summary-only (dry run) mode
- Timezone awareness
- Visualization of signals
- Flaky reviewer detection

## License

MIT
