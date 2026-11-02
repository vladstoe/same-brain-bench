# same-brain-bench

Written by Vlad Stoenescu.

## What this is

This is the benchmark behind my blog post, [Same model, better habits](BLOG_POST_URL) <!-- TODO: replace BLOG_POST_URL with the link to the post -->, and the [comic](https://vladstoe.github.io/same-brain-comic/) that goes with it. I gave Claude Code and Claude Code inside Traycer the same job, the same model and the same settings, five times each, and graded every result with a checker I wrote before the first run. This repo holds everything I ran: the rig that drives both tools, the metering proxy, the checker and its test fixtures, the frozen prompts and the codebase they worked on. You can read it to see exactly what I tested, or run it yourself.

## The test

The starting point is a small library-management API in TypeScript, about 3,000 lines with its tests. It lives in [`seed/`](seed). Each run gets a fresh clone of it.

The job is nine features:

- book holds, and hold queues;
- overdue fines, and fine waivers;
- renewal limits, and member suspension;
- a nightly reconciliation job and a weekly summary job;
- member statements.

The full task, route by route, is in [`evaluate/texts/task.txt`](evaluate/texts/task.txt). The code also has to keep six design rules, quoted here from [`evaluate/texts/rules.txt`](evaluate/texts/rules.txt):

> D1. Money is never changed in place. A fine, a payment and a waiver are each recorded as a new row, and nothing updates or deletes a row in any table that holds fines, payments or waivers.
>
> D2. Availability is never stored; it is worked out from loans and holds when it is read. `books` and `copies` gain no columns. Borrowing, returning and renewing write only the loan and audit entries, plus a row in `fines` for an overdue return. Placing and cancelling a hold write only audit entries and tables added for holds.
>
> D3. A hold is on a book, not on a copy. It never records a particular copy; any copy of the book can satisfy it.
>
> D4. Who may do what is decided only by rows in `permissions`. Every new route uses the existing `requirePermission(action)` guard and no code compares a role name, so a role given another role's permission rows can do exactly what that role can.
>
> D5. Reports are built only from the audit log. A change that left no audit entry appears in no report.
>
> D6. Nightly work runs only when something triggers it through the scheduler: register it as a job, like `daily-circulation`. Add no timers, no cron and no new dependencies.

Each run is one conversation with two messages, the same words for both tools:

1. [`prompts/plan.txt`](prompts/plan.txt) asks how we'd add the features, gives the task and the rules, and asks for the plan as tickets. It ends with "Don't build anything yet".
2. [`prompts/build.txt`](prompts/build.txt) says "Now build all the tickets. Use whatever your environment offers for splitting the work across agents and reviewing it. Keep the existing tests passing."

Neither message names a skill or a feature of either product. If a tool stops to ask something, the rig answers with one fixed line from [`prompts/approval-policy.txt`](prompts/approval-policy.txt) and never more than that.

## How a run works

The rig plays both turns of the conversation and then grades what's left in the clone.

- **Arm C** is Claude Code on its own. The rig runs it headless, `claude -p`, with a config folder made fresh for the attempt. The build turn resumes the plan turn's session. Claude Code splits the work with its own subagents, or doesn't.
- **Arm T** is Claude Code inside Traycer. The rig uses Traycer's CLI to create a coordinator agent in the attempt's own Traycer task and send it both turns. The coordinator splits the work its own way, with child agents, subagents or neither. The build turn settles once the coordinator has replied and every agent under it is idle. Then the rig stops and archives every agent in the task.

Each attempt is kept apart from the others and from my machine:

- a fresh clone of the seed, checked to hold one commit, `main` and the `seed-v2` tag, and nothing else;
- a hash check on the seed files after the plan turn, so a plan turn that edits code fails as `planViolation`;
- an audit that lists every file a session read outside the attempt's own folders. It is reported, never scored.

A local proxy on `127.0.0.1:8787` sits between both tools and the Anthropic API. It passes every call through and writes one ledger row per response, with the token counts from the API's own usage block. Cost is those tokens at Opus 5.5's list prices, frozen in the config on 2026-09-24. Both arms ran on a Claude subscription, so the dollar figures are what the same calls would cost on the API.

I kept the setup equal wherever I could:

- Every agent and subagent in both arms runs `opus[1m]`, which resolves to `claude-opus-5-5`, at effort `high`. `CLAUDE_CODE_SUBAGENT_MODEL` and its force switch pin the subagents.
- Both arms run the same Claude Code build, 2.1.293. Arm C runs the binary Traycer bundles. The rig refuses to start an attempt if Traycer has moved to another build, and it excludes an attempt if any session ran on another build or another model.
- Tool search is on in both arms. Traycer's claude.ai connectors are off.
- `rig routing set` swaps Traycer's agent selection guide for one line that puts every agent on the same model and effort. `rig routing clear` restores the original byte for byte.

Two differences stay. Traycer's own system prompt, tools and skills are the product, so they stay in. About 3,250 tokens of account plugin skills also reach arm T's sessions, because Claude Code has no switch to remove them.

The checker in [`evaluate/`](evaluate) is a separate package. It copies the finished clone, installs it, starts the API against a fresh database and runs a fixed scenario of HTTP calls. It never looks at how the code is written, only at what the API does and what it writes to the database.

- **One check per feature**, nine in all. Each one sends the requests the task describes and compares the answers with values it works out from its own calls.
- **The seed's own tests**, from the original tag, must still pass.
- **One check per rule.** SQLite triggers record every write each call makes, which decides D1 to D3. D4 swaps permission rows between roles and checks the routes follow them. D5 writes rows that leave no audit entry and checks the reports don't move. D6 checks that no nightly report exists before the job first runs, the dependencies are unchanged and no timer was added.

A run passes only if all nine features, the seed tests and all six rules pass. To prove the checks fire on what they claim, [`fixtures/`](fixtures) holds 34 hand-written patches against the seed: a reference implementation, four other correct designs, one patch per rule violation or missing feature, an empty patch and a broken one. The gate runs the checker on every fixture and asserts the whole row of results. It passes 34 of 34.

## Requirements

- macOS on Apple Silicon. It's the only setup I've tested.
- Node 22 or later, and git.
- Claude Code 2.1.293, the build both arms ran.
- A Claude subscription token from `claude setup-token`.
- For arm T: Traycer 1.5.1 and its CLI, and one Traycer task per attempt that you create by hand in the Traycer app. Each task needs one agent to act as the sender, switched off the `claude` harness to another one such as codex. Otherwise it takes a turn on every reply and its calls land in the attempt's ledger.

## Running it

The free steps come first. None of them calls a model.

```bash
npm ci
(cd evaluate && npm ci)
scripts/make-seed-repo.sh
cp bench.example.json bench.config.json
./bin/rig preflight
npm run typecheck
npm run selftest
(cd evaluate && npm run gate)
./bin/rig run C 1 --dry-run --config scripts/dryrun.v3.json
./bin/rig run T 1 --dry-run --config scripts/dryrun.v3.json
./bin/rig report --config scripts/dryrun.v3.json
```

- `scripts/make-seed-repo.sh` builds `.seed-repo`, the repo the rig clones for each attempt. Every build gives the same commit hash.
- Preflight will flag what you haven't set up yet: the token, the Traycer tasks in `bench.config.json`, and a Traycer that has moved past Claude Code 2.1.293. The last one is a failure, so preflight exits with an error until your Traycer runs that build. The dry runs and the gate don't need any of it.
- The dry runs use stand-ins for Claude Code and Traycer, apply the reference fixture as the build, and run everything else for real, the checker included. They write to `runs-dry/`. Delete it before running them again.
- A dry run's reconcile line reads "mismatch". That's expected. The stand-ins make no real model calls, so there are no native token counts to match the ledger. The original rig does the same.

Then the paid part. Fill `bench.config.json` with your Traycer task and sender ids, and check `claudeBinary` and the `~/.traycer` paths.

```bash
export CLAUDE_CODE_OAUTH_TOKEN=<the token from claude setup-token>
./bin/rig prepare
./bin/rig routing set
./bin/rig run C 0
./bin/rig run T 0
./bin/rig batch --k 5 --arms C,T
./bin/rig routing clear
./bin/rig report
```

- `rig routing set` points Traycer's Claude Code at the proxy and swaps in the bench selection guide. `rig routing clear` puts both back. While routing is set, every Traycer Claude agent on the machine goes through the proxy, so keep your other Traycer chats idle. Arm T refuses to start without it. Arm C doesn't care either way.
- Attempt 0 is an unscored rehearsal of each arm. Arm T uses the smoke task for it. The report lists attempt 0 apart and never counts it. `rig batch` runs attempts 1 to k, alternating the arms.
- An attempt costs about $8 for Claude Code and $13 for Traycer at API prices. On a subscription it comes out of your usage instead.
- `./bin/rig preflight --probes` sends one tiny paid call through the proxy as arm C would. It plants a canary `CLAUDE.md` in your real Claude Code config folder to prove arm C can't see it, and prints the `rm` to remove it afterwards.

## The Traycer caveat

The rig reads Traycer's local chat database to find each agent's turns, settings and Claude Code sessions. Around each arm-T attempt it also edits Traycer's provider overrides and selection guide. None of that is a public API. Traycer 1.5.1 already changed how it stores chats once while I was building this. Another Traycer version may need changes in `src/traycer-store.ts` and `src/routing.ts`.

## Results, v3 at k=5

Ten scored attempts, five per tool, on 2026-10-16 and 2026-10-18.

| | Claude Code | Claude Code + Traycer |
| --- | --- | --- |
| Runs that passed every check | 2 of 5 (95% CI 5.3% to 85.3%) | 4 of 5 (95% CI 28.4% to 99.5%) |
| Features complete | 39 of 45 | 43 of 45 |
| Design rules kept | 30 of 30, all six in every run | 30 of 30, all six in every run |
| Average time per run | 22.3 min | 21.4 min |
| Average cost per run | $8.43 | $13.38 |
| Total cost, five runs | $42.15 | $66.88 |
| Cost per passing run | $21.08 | $16.72 |

Every failure failed the same two checks, hold queues and renewal limits, and nothing else. The task says a hold ends when its member cancels it. It never says what happens when the holder borrows the book. Plans that kept the hold active until it was cancelled passed, six of six. Plans that ended it on the borrow failed, four of four. Traycer's plans kept the literal reading in 4 of 5 runs, and Claude Code's in 2 of 5.

Traycer cost 1.59 times as much. Each of its agents starts with 68,000 to 71,000 tokens of instructions and tools, against about 20,000 for a Claude Code session and 13,500 to 15,000 for a subagent. It also made more calls, 1,070 against 648.

After the runs, one Opus reviewer scored the ten builds. It didn't know which tool made which build when it scored the code. The written records couldn't be scored blind, because the two tools keep them in different forms.

| Mean | Claude Code | Claude Code + Traycer |
| --- | --- | --- |
| Code, out of 10 | 6.8 | 7.8 |
| Find what was built, out of 5 | 4.0 | 4.8 |
| Decisions and reasons, out of 5 | 5.0 | 5.0 |
| Open questions, out of 5 | 4.8 | 4.4 |
| Records match the code, out of 5 | 4.8 | 4.2 |
| Follow the change, out of 5 | 3.0 | 4.4 |
| Records overall, out of 10 | 6.8 | 7.6 |

How far this goes:

- Five runs a side is a small sample. If the tools were equally good, a split at least this lopsided would happen about one time in four. A one-sided Fisher's exact test gives 0.26.
- One codebase of about 3,000 lines, and one model, Opus 5.5 at `high`.
- The checker reads "active hold" as "not cancelled", the only end of a hold the task names. I fixed that on 2026-10-11, before any v3 run. Read the other way, the same builds give Traycer 1 of 5 and Claude Code 3 of 5.
- Nobody answers the plans' open questions. A person answering them would likely have settled the hold question, and with it the difference between the tools.
- An earlier fourth Traycer attempt was stopped and voided, so Traycer's runs are numbered 1, 2, 3, 5 and 6.

## What differs from the original runs

- **The seed commit.** I rebuilt it with a neutral author, `same-brain-bench <seed@same-brain-bench.invalid>`, and the original date. The files and the commit message are the same, and so is the tree hash, `c6154c7a6705`. The commit hash is `27e591c0dd74` instead of `d476f1b2bf37`.
- **Paths.** The config, the prompt files and the checker live where this repo puts them, and the prompts are `.txt` files with the same bytes. The bench root and the seed repo are inside the repo.
- **The report.** `rig report` no longer prints the "Boundary verified" column. It belonged to the earlier cold-handoff versions and was empty in every v3 row.
