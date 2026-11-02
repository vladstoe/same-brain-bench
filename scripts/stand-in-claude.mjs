#!/usr/bin/env node
// Stands in for `claude -p` in a v3 dry run. It calls no model. It writes the session
// and one subagent transcript where Claude Code 2.1.284 writes them, under
// CLAUDE_CONFIG_DIR/projects/<slug>/<session>.jsonl and <session>/subagents/, makes
// the turn's change in the working directory, and prints a result object.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("2.1.284 (stand-in claude for dry runs)");
  process.exit(0);
}

const value = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};
const sessionId = value("--resume") ?? value("--session-id");
const modelArg = value("--model") ?? "opus[1m]";
const effort = value("--effort") ?? "medium";
const prompt = args[args.length - 1] ?? "";
const configDir = process.env.CLAUDE_CONFIG_DIR;
if (sessionId === undefined || configDir === undefined) {
  console.error("stand-in claude needs --session-id or --resume, and CLAUDE_CONFIG_DIR");
  process.exit(2);
}

const resolve = (ref) =>
  ref.startsWith("claude-") ? ref : ref.startsWith("opus") ? "claude-opus-5-5" : ref.startsWith("sonnet") ? "claude-sonnet-5-5" : ref;
const model = resolve(modelArg);
const subagentModel = resolve(process.env.CLAUDE_CODE_SUBAGENT_MODEL ?? modelArg);

const cwd = process.cwd();
const projectDir = path.join(configDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
fs.mkdirSync(projectDir, { recursive: true });
const sessionFile = path.join(projectDir, `${sessionId}.jsonl`);
const existing = fs.existsSync(sessionFile)
  ? fs.readFileSync(sessionFile, "utf8").split("\n").filter((l) => l.includes('"type":"assistant"')).length
  : 0;

const kind = prompt.startsWith("Think through") ? "plan" : prompt.startsWith("Now build") ? "build" : "reply";
const now = () => new Date().toISOString();
const short = sessionId.slice(0, 8);

const record = (id, m, extra = {}) =>
  JSON.stringify({
    type: "assistant",
    sessionId,
    cwd,
    effort,
    version: "2.1.284",
    ...extra,
    message: { id, model: m, role: "assistant", content: [{ type: "text", text: "stand-in" }] },
    timestamp: now(),
  });

const count = kind === "build" ? 4 : kind === "plan" ? 3 : 1;
const lines = [JSON.stringify({ type: "user", sessionId, cwd, message: { role: "user", content: prompt }, timestamp: now() })];
for (let i = 1; i <= count; i++) lines.push(record(`msg_c_${short}_${existing + i}`, model));
fs.appendFileSync(sessionFile, lines.join("\n") + "\n");

if (kind !== "reply") {
  const agentId = `a${short}${kind}`;
  const subDir = path.join(projectDir, sessionId, "subagents");
  fs.mkdirSync(subDir, { recursive: true });
  const sub = [1, 2].map((i) => record(`msg_c_${short}_${kind}_sub_${i}`, subagentModel, { isSidechain: true, agentId }));
  fs.writeFileSync(path.join(subDir, `agent-${agentId}.jsonl`), sub.join("\n") + "\n");
  fs.writeFileSync(
    path.join(subDir, `agent-${agentId}.meta.json`),
    JSON.stringify({
      agentType: kind === "plan" ? "Explore" : "general-purpose",
      description: kind === "plan" ? "Map the routes" : "Review the build",
      spawnDepth: 1,
    }) + "\n",
  );
}

if (kind === "plan") {
  const plan = path.join(cwd, "docs", "plan");
  fs.mkdirSync(plan, { recursive: true });
  fs.writeFileSync(path.join(plan, "README.md"), "# Plan\n\nTickets 01 to 04, in order.\n");
  fs.writeFileSync(path.join(plan, "01-holds.md"), "# 01 Holds and queues\n");
}
if (kind === "build") {
  const patch = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "compliant.patch");
  execFileSync("git", ["apply", patch], { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

const assistant = existing + count;
console.log(
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: kind === "plan" ? "The plan is written up as four tickets in docs/plan." : "All four tickets are built and reviewed.",
    session_id: sessionId,
    num_turns: assistant,
    total_cost_usd: Number((0.1 * assistant).toFixed(4)),
    usage: { input_tokens: 50 * count, output_tokens: 400 * count, cache_read_input_tokens: 20000 * count, cache_creation_input_tokens: 0 },
    modelUsage: { [model]: {} },
  }),
);
