#!/usr/bin/env node
import fs from "node:fs/promises";

import { Command } from "commander";

import { checkAuth, linearDoctor } from "./auth";
import { getMyBlocked } from "./blocked";
import { getBoard, getRecentlyDone, getReviewQueue, getStalled } from "./boards";
import { considerWork, refuseWork, beginWork, handoffWork, complete, needsHuman, observeIssue, note, undelegate, parkWork, manageWork, accept, submit, approve, requestChanges, deploy, reject, escape, demote } from "./semantic";
import { addComment, createIssue, findUserByName, resolveUserWithHints, getIssue, getMyIssues, getMyManaging, getMyNewIssues, getMyQueue, updateIssue, verifyComment } from "./issues";
import { attachIssueToMilestone, attachIssueToProject, attachIssueToProjectById, createMilestone, createProject, editProject, findProjectByName, getProjectDetail, getProjectIssues, listMilestones, listProjects } from "./projects";
import { createBlockingRelation, listRelations, removeBlockingRelation, removeParentIssue, setParentIssue } from "./relations";
import { findSemanticState, findStateByName, getWorkflowStates } from "./states";
import { listTeams, resolveTeamId } from "./teams";
import { uploadFile } from "./upload";
import { fetchImage } from "./fetch-image";
import { deleteIssue, deleteComment } from "./delete";
import { listLabels, addLabels, removeLabels } from "./labels";
import { searchIssues } from "./search";
import { linearTest } from "./test";
import { linearGraphQL, LinearApiError } from "./client";
import { normalizeCliDescription, relativeTime, wrapText } from "./utils";
import { ObserveResult } from "./semantic";
import { setDebugMode, isDebugMode } from "./debug";
import { CreateIssueInput, UpdateIssueInput } from "./types";

interface NotificationsResponse {
  notifications: {
    nodes: Array<{
      id: string;
      type: string;
      readAt?: string | null;
      createdAt: string;
      updatedAt: string;
      issue?: { id: string; identifier: string; title: string; state?: { name: string } };
      project?: { id: string; name: string };
    }>;
  };
}

interface UrgentIssuesResponse {
  issues: {
    nodes: Array<{
      id: string;
      identifier: string;
      title: string;
      priority: number;
      url: string;
      state?: { name: string; type: string };
      assignee?: { name: string };
      team?: { key: string; name: string };
    }>;
  };
}

interface StandupIssueNode {
  id: string;
  identifier: string;
  title: string;
  priority?: number;
  team?: { key: string };
}

interface StandupResponse {
  todos: { assignedIssues: { nodes: StandupIssueNode[] } };
  inProgress: { assignedIssues: { nodes: StandupIssueNode[] } };
  recentlyDone: { assignedIssues: { nodes: StandupIssueNode[] } };
}

interface BranchResponse {
  issue: { branchName: string } | null;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Expected a number, got "${value}".`);
  }
  return parsed;
}

function isObserveResult(value: unknown): value is ObserveResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "identifier" in value &&
    "comments" in value &&
    "createdAt" in value
  );
}

function hasObserveContext(value: unknown): value is { context: ObserveResult } {
  return (
    typeof value === "object" &&
    value !== null &&
    "context" in value &&
    isObserveResult((value as { context?: unknown }).context)
  );
}

type RenderEvent =
  | { kind: "comment"; createdAt: string; body: string; user: string }
  | { kind: "history"; createdAt: string; actor: string | null; type: "state" | "delegate" | "assignee" | "priority"; from: string | null; to: string | null };

type RenderComment = ObserveResult["comments"][number];

function isHumanAuthoredComment(comment: RenderComment): boolean {
  const user = comment.user;
  if (user?.name === "Matt Henry") return true;
  if (user?.isAgent === false) return true;
  if (user?.isAgent === true) return false;
  if (user?.app === true) return false;
  if (user?.app === false) return true;

  // Linear does not currently expose an isAgent flag in all workspaces. Our
  // agent accounts conventionally include a role in parentheses, e.g.
  // "Astrid (CPO)" or "Igor (Back End Dev)". Treat those as agents so
  // human-only pins don't become noisy when the API lacks explicit metadata.
  return !/\([^)]+\)\s*$/.test(user?.name ?? "");
}

function renderCommentBlock(comment: RenderComment): string[] {
  const rel = comment.createdAt ? relativeTime(comment.createdAt) : "";
  const stamp = `${comment.createdAt}${rel ? ` (${rel})` : ""}`;
  return [
    `💬 ${stamp} — ${comment.user?.name ?? "Unknown"}`,
    `   ${wrapText(comment.body, 70).split("\n").join("\n   ")}`,
  ];
}

function renderPinnedComments(data: ObserveResult): string[] {
  const humanComments = data.comments
    .filter(isHumanAuthoredComment)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (humanComments.length === 0) return [];

  const lines: string[] = [
    "",
    "── Human comments pinned above agent history ────────────────",
    "",
  ];
  for (const comment of humanComments) {
    lines.push(...renderCommentBlock(comment), "");
  }
  lines.push("--- agent history below ---");

  return lines;
}

function renderTimeline(data: ObserveResult): string {
  const lines: string[] = [];
  const sep = "─".repeat(56);

  // Header
  lines.push(`${data.identifier} | ${data.title}`);
  const metaParts = [`State: ${data.state.name}`, `Priority: ${data.priority}`];
  if (data.createdAt) {
    const rel = data.createdAt ? relativeTime(data.createdAt) : "";
    metaParts.push(`Created: ${data.createdAt}${rel ? ` (${rel})` : ""}`);
  }
  lines.push(metaParts.join(" | "));
  if (data.assignee) lines.push(`Assignee: ${data.assignee.name}`);
  if (data.delegate) lines.push(`Delegate: ${data.delegate.name}`);

  lines.push(...renderPinnedComments(data));

  lines.push("");
  lines.push(`── Timeline ${sep}`);
  lines.push("");

  // Issue creation event
  if (data.createdAt) {
    const rel = relativeTime(data.createdAt);
    lines.push(`📌 ${data.createdAt} (${rel}) — Issue created`);
  }

  // Merge comments + history into one chronological stream. When human
  // comments are pinned above the fold, omit them here to avoid duplicating
  // them below the separator.
  const hasPinnedHumanComments = data.comments.some(isHumanAuthoredComment);
  const timelineComments = hasPinnedHumanComments
    ? data.comments.filter((c) => !isHumanAuthoredComment(c))
    : data.comments;
  const merged: RenderEvent[] = [
    ...timelineComments.map((c): RenderEvent => ({
      kind: "comment", createdAt: c.createdAt, body: c.body, user: c.user?.name ?? "Unknown",
    })),
    ...(data.history ?? []).map((h): RenderEvent => ({
      kind: "history", createdAt: h.createdAt, actor: h.actor, type: h.type, from: h.from, to: h.to,
    })),
  ];
  merged.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  for (const ev of merged) {
    const rel = ev.createdAt ? relativeTime(ev.createdAt) : "";
    const stamp = `${ev.createdAt}${rel ? ` (${rel})` : ""}`;
    lines.push("");
    if (ev.kind === "comment") {
      lines.push(`💬 ${stamp} — ${ev.user}`);
      lines.push(`   ${wrapText(ev.body, 70).split("\n").join("\n   ")}`);
    } else {
      const actor = ev.actor ? ` by ${ev.actor}` : "";
      const from = ev.from ?? "—";
      const to = ev.to ?? "—";
      const label = ev.type[0].toUpperCase() + ev.type.slice(1);
      lines.push(`🔄 ${stamp}${actor} — ${label}: ${from} → ${to}`);
    }
  }

  return lines.join("\n") + "\n";
}

function printResult(result: unknown, human = false): void {
  if (human && isObserveResult(result)) {
    process.stdout.write(renderTimeline(result));
    return;
  }

  if (human && hasObserveContext(result)) {
    process.stdout.write(renderTimeline(result.context));
    return;
  }

  if (!human) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (typeof result === "string") {
    process.stdout.write(`${result}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function runCommand(handler: () => Promise<unknown>, human = false): Promise<void> {
  try {
    const result = await handler();
    printResult(result, human);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    if (isDebugMode() && error instanceof LinearApiError && error.details?.length) {
      process.stderr.write(`[DEBUG] Raw GraphQL error details: ${JSON.stringify(error.details, null, 2)}\n`);
    }
    process.exitCode = 1;
  }
}

const DEPRECATION_MSG =
  "⚠️  This command is deprecated for agent use. Use semantic commands: consider-work, refuse-work, begin-work, handoff-work, complete, needs-human, park. Pass --silence-deprecation to suppress.";

const INLINE_COMMENT_HELP = "Inline --comment is shell-parsed; use --comment-file for bodies with backticks, code, paths, or Markdown.";

function deprecationWarn(cmd: string, noWarn?: boolean): void {
  if (!noWarn) {
    process.stderr.write(`${DEPRECATION_MSG}\n`);
  }
}

/**
 * Build a usage hint string from the matched subcommand.
 * Returns empty string if no subcommand matched.
 */
function buildUsageHint(cmd: Command, subName: string): string {
  const sub = cmd.commands.find((c) => c.name() === subName || c.aliases().includes(subName));
  if (!sub) return "";
  const lines = [`\nUsage: linear ${sub.name()} ${sub.usage()}`, `See 'linear ${sub.name()} --help' for available options.`];
  return lines.join("\n");
}

/**
 * Find the closest matching command name using simple Levenshtein distance.
 */
function suggestCommand(cmd: Command, input: string): string | undefined {
  const names = cmd.commands.map((c) => [c.name(), ...c.aliases()] as string[]).flat();
  let best: string | undefined;
  let bestDist = Infinity;
  for (const name of names) {
    const d = levenshtein(input.toLowerCase(), name.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = name;
    }
  }
  // Only suggest if reasonably close
  return bestDist <= 3 ? best : undefined;
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[m][n];
}

async function main(): Promise<void> {
  const program = new Command();
  program.name("linear").description("Linear CLI for OpenClaw").option("--human", "Use readable output").option("--debug", "Dump raw GraphQL errors to stderr");
  setDebugMode(!!program.opts<{ debug?: boolean }>().debug);

  // Unknown command — suggest similar command names
  program.on("command:*", (operands) => {
    const unknown = operands[0];
    if (unknown) {
      const suggestion = suggestCommand(program, unknown);
      const msg = suggestion
        ? `error: unknown command '${unknown}'\nDid you mean '${suggestion}'?\nSee 'linear --help' for available commands.`
        : `error: unknown command '${unknown}'\nSee 'linear --help' for available commands.`;
      process.stderr.write(`${msg}\n`);
      process.exitCode = 1;
    }
  });

  const auth = program.command("auth").description("Auth operations");
  auth.command("check").description("Verify auth").action(async () => {
    await runCommand(async () => ({ viewer: await checkAuth() }), program.opts<{ human?: boolean }>().human);
  });
  auth.command("doctor").description("Diagnose Linear auth and CLI setup").action(async () => {
    await runCommand(async () => linearDoctor(), program.opts<{ human?: boolean }>().human);
  });

  // --- Consolidated queue + my-issues commands ---

  // --- Extracted handler functions for canonical commands ---

  async function handleQueue(options: { next?: boolean; blocked?: boolean; project?: string; includeBacklog?: boolean }): Promise<unknown> {
    if (options.blocked) return getMyBlocked(undefined);
    const queue = await getMyQueue(options.project, { includeBacklog: options.includeBacklog });
    if (options.next) {
      if (queue.length === 0) return { message: "Queue is empty — nothing to do." };
      return queue[0];
    }
    return queue;
  }

  async function handleMyIssues(options: { status?: string; new?: boolean; since?: string }): Promise<unknown> {
    if (options.new) return getMyNewIssues(options.since);
    if (options.status) return getMyIssues([options.status]);
    return getMyIssues();
  }

  program.command("queue")
    .description("Issues delegated to you (your work queue)")
    .option("--next", "Return only the highest-priority issue")
    .option("--blocked", "Show only blocked issues")
    .option("--project <name>", "Filter by project name")
    .option("--include-backlog", "Include parked Backlog issues")
    .action(async (options: { next?: boolean; blocked?: boolean; project?: string; includeBacklog?: boolean }) => {
      await runCommand(() => handleQueue(options), program.opts<{ human?: boolean }>().human);
    });

  program.command("my-issues")
    .description("All issues assigned or delegated to you")
    .option("--status <status>", "Filter by status name (e.g. 'To Do', 'Thinking')")
    .option("--new", "Show only new (unviewed) issues")
    .option("--since <iso>", "Issues created since this date")
    .action(async (options: { status?: string; new?: boolean; since?: string }) => {
      await runCommand(() => handleMyIssues(options), program.opts<{ human?: boolean }>().human);
    });

  // --- Legacy my-* commands (hidden, backward compat) ---
  // These are thin wrappers that delegate to the canonical commands.

  program.command("my-todos", { hidden: true }).action(async () => {
    await runCommand(() => handleMyIssues({ status: "Todo" }), program.opts<{ human?: boolean }>().human);
  });

  program.command("my-new", { hidden: true }).option("--since <iso>").action(async (options: { since?: string }) => {
    await runCommand(() => handleMyIssues({ new: true, since: options.since }), program.opts<{ human?: boolean }>().human);
  });

  program.command("my-queue", { hidden: true })
    .option("--project <name>", "Filter by project name")
    .option("--include-backlog", "Include parked Backlog issues")
    .action(async (options: { project?: string; includeBacklog?: boolean }) => {
      await runCommand(() => handleQueue({ project: options.project, includeBacklog: options.includeBacklog }), program.opts<{ human?: boolean }>().human);
    });

  program.command("my-next", { hidden: true }).action(async () => {
    await runCommand(() => handleQueue({ next: true }), program.opts<{ human?: boolean }>().human);
  });

  program.command("issue").argument("<id>").action(async (id: string) => {
    await runCommand(async () => getIssue(id), program.opts<{ human?: boolean }>().human);
  });

  program
    .command("create")
    .argument("<team>")
    .argument("<title>")
    .option("--description <description>")
    .option("--description-file <path>", "Read Markdown/multiline description from file")
    .option("--project <name|id>", "Project name or ID")
    .option("--milestone <milestoneId>")
    .option("--assignee <name|uuid>")
    .option("--delegate <name|uuid>")
    .option("--priority <priority>")
    .option("--parent <parentId>")
    .option("--state <state>", "Workflow state name or semantic alias (todo, backlog, doing, thinking). Defaults to To Do.")
    .option("--dry-run", "Resolve inputs and print the create payload without creating an issue")
    .action(async (team: string, title: string, options: Record<string, string | boolean | undefined>) => {
      await runCommand(async () => {
        const teamId = await resolveTeamId(team);
        const assigneeName = typeof options.assignee === "string" ? options.assignee : undefined;
        const delegateName = typeof options.delegate === "string" ? options.delegate : undefined;
        const assignee = assigneeName ? await resolveUserWithHints(assigneeName, "create") : undefined;
        const delegate = delegateName ? await resolveUserWithHints(delegateName, "create") : undefined;
        const stateName = typeof options.state === "string" ? options.state : undefined;
        if (stateName && stateName.toLowerCase() === "backlog" && (assigneeName || delegateName)) {
          process.stderr.write(
            "Warning: creating a Backlog ticket with an assignee or delegate. " +
            "Backlog tickets are skipped by the Linear connector — this ticket will not be picked up automatically. " +
            "If the work is ready for implementation, use --state todo instead.\n"
          );
        }
        let description = typeof options.description === "string" ? options.description : undefined;
        const descriptionFile = typeof options.descriptionFile === "string" ? options.descriptionFile : undefined;
        if (descriptionFile) {
          if (description) {
            throw new Error("Use either --description or --description-file, not both.");
          }
          description = await fs.readFile(descriptionFile, "utf8");
        } else if (description) {
          const normalized = normalizeCliDescription(description);
          if (normalized !== description) {
            process.stderr.write("Warning: converted literal \\n sequences in --description to real newlines. Prefer --description-file for Markdown/multiline descriptions.\n");
          }
          description = normalized;
        }
        let projectId = typeof options.project === "string" ? options.project : undefined;
        if (projectId && !projectId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
          const project = await findProjectByName(projectId);
          projectId = project.id;
        }
        // Default to "todo" so the CLI matches its --help text. Without this,
        // Linear's API silently demotes issues to Backlog when no project is set,
        // and the connector won't auto-dispatch them. See AI-1097.
        const effectiveStateName = stateName ?? "todo";
        const stateId = teamId ? (await findSemanticState(teamId, effectiveStateName)).id : undefined;
        const input: CreateIssueInput = {
          title,
          description,
          projectId,
          projectMilestoneId: typeof options.milestone === "string" ? options.milestone : undefined,
          assigneeId: assignee?.id,
          delegateId: delegate?.id,
          priority: parseOptionalNumber(typeof options.priority === "string" ? options.priority : undefined),
          parentId: typeof options.parent === "string" ? options.parent : undefined,
          stateId
        } as CreateIssueInput;
        if (teamId) {
          input.teamId = teamId;
        }
        if (options.dryRun) {
          return input;
        }
        return createIssue(input);
      }, program.opts<{ human?: boolean }>().human);
    });

  program
    .command("comment", { hidden: true })
    .argument("<id>")
    .argument("[body]")
    .option("--body-file <path>", "Read comment from file; required for bodies with backticks, code, paths, or Markdown")
    .description(`Removed legacy comment command. ${INLINE_COMMENT_HELP}`)
    .action(async () => {
      console.error("Error: 'linear comment' has been removed. Comments must be paired with a state transition.");
      console.error("Use one of: handoff-work, needs-human, refuse-work, note, or complete.");
      console.error(INLINE_COMMENT_HELP);
      process.exit(1);
    });

  program.command("states").argument("<team>").option("--refresh").action(async (team: string, options: { refresh?: boolean }) => {
    await runCommand(async () => {
      const teamId = await resolveTeamId(team);
      return getWorkflowStates(teamId, Boolean(options.refresh));
    }, program.opts<{ human?: boolean }>().human);
  });

  program.command("status", { hidden: true }).argument("<id>").argument("<state>").option("--team <teamId>").option("--silence-deprecation", "Suppress deprecation warning").action(async (id: string, state: string, options: { team?: string; silenceDeprecation?: boolean }) => {
    deprecationWarn("status", options.silenceDeprecation);
    await runCommand(async () => {
      const issue = await getIssue(id);
      const teamId = options.team ?? issue.team?.id;
      if (!teamId) {
        throw new Error(`Unable to resolve a team for issue ${id}. Pass --team explicitly.`);
      }
      const resolved = await findStateByName(teamId, state);
      return updateIssue(id, { stateId: resolved.id });
    }, program.opts<{ human?: boolean }>().human);
  });

  program.command("edit").argument("<id>").option("--title <title>").option("--description <description>").action(async (id: string, options: { title?: string; description?: string }) => {
    await runCommand(async () => {
      if (!options.title && !options.description) {
        throw new Error("At least one of --title or --description is required.");
      }
      const input: UpdateIssueInput = {};
      if (options.title) {
        input.title = options.title;
      }
      if (options.description) {
        input.description = options.description;
      }
      return updateIssue(id, input);
    }, program.opts<{ human?: boolean }>().human);
  });

  program.command("assign", { hidden: true }).argument("<id>").argument("<user>").option("--silence-deprecation", "Suppress deprecation warning").action(async (id: string, userName: string, options: { silenceDeprecation?: boolean }) => {
    deprecationWarn("assign", options.silenceDeprecation);
    await runCommand(async () => {
      const user = await findUserByName(userName);
      return updateIssue(id, { assigneeId: user.id, delegateId: null });
    }, program.opts<{ human?: boolean }>().human);
  });

  program.command("delegate", { hidden: true }).argument("<id>").argument("<agent>").option("--silence-deprecation", "Suppress deprecation warning").action(async (id: string, agentName: string, options: { silenceDeprecation?: boolean }) => {
    deprecationWarn("delegate", options.silenceDeprecation);
    await runCommand(async () => {
      const user = await findUserByName(agentName);
      return updateIssue(id, { delegateId: user.id });
    }, program.opts<{ human?: boolean }>().human);
  });

  program.command("priority").argument("<id>").argument("<level>").action(async (id: string, level: string) => {
    await runCommand(async () => updateIssue(id, { priority: parseOptionalNumber(level) }), program.opts<{ human?: boolean }>().human);
  });

  program.command("handoff", { hidden: true }).argument("<id>").argument("<reviewer>").argument("[comment]").option("--comment-file <path>", "Read comment from file; required for bodies with backticks, code, paths, or Markdown").option("--silence-deprecation", "Suppress deprecation warning").action(async (id: string, reviewer: string, comment: string | undefined, options: { commentFile?: string; silenceDeprecation?: boolean }) => {
    deprecationWarn("handoff", options.silenceDeprecation);
    await runCommand(async () => handoffWork(id, reviewer, { comment, commentFile: options.commentFile }), program.opts<{ human?: boolean }>().human);
  });

  program.command("projects").action(async () => {
    await runCommand(async () => listProjects(), program.opts<{ human?: boolean }>().human);
  });
  program.command("project-detail").argument("<name>").action(async (name: string) => {
    await runCommand(async () => getProjectDetail(name), program.opts<{ human?: boolean }>().human);
  });
  program.command("project-attach").argument("<id>").argument("<name>").action(async (id: string, name: string) => {
    await runCommand(async () => attachIssueToProject(id, name), program.opts<{ human?: boolean }>().human);
  });
  program.command("project-issues").argument("<name>").action(async (name: string) => {
    await runCommand(async () => getProjectIssues(name), program.opts<{ human?: boolean }>().human);
  });
  program.command("milestones").argument("<team>").action(async (team: string) => {
    await runCommand(async () => {
      const teamId = await resolveTeamId(team);
      return listMilestones(teamId);
    }, program.opts<{ human?: boolean }>().human);
  });
  program.command("milestone-create").argument("<project>").argument("<name>").argument("<targetDate>").action(async (project: string, name: string, targetDate: string) => {
    await runCommand(async () => createMilestone(project, name, targetDate), program.opts<{ human?: boolean }>().human);
  });
  program.command("milestone-attach").argument("<id>").argument("<name>").action(async (id: string, name: string) => {
    await runCommand(async () => attachIssueToMilestone(id, name), program.opts<{ human?: boolean }>().human);
  });
  program.command("project-create").argument("<team>").argument("<name>").option("--description <text>", "Project description").option("--description-file <path>", "Path to file containing description (overrides --description)").option("--lead <name|uuid>", "Lead user name or UUID").option("--state <state>", "Project state (Planned|Started|Paused|Completed|Canceled)").option("--target-date <date>", "Target date (YYYY-MM-DD)").option("--start-date <date>", "Start date (YYYY-MM-DD)").action(async (team: string, name: string, options: { description?: string; descriptionFile?: string; lead?: string; state?: string; targetDate?: string; startDate?: string }) => {
    await runCommand(async () => {
      let description = options.description
      if (options.descriptionFile) {
        description = await fs.readFile(options.descriptionFile, "utf-8")
      }
      return createProject(team, name, { description, lead: options.lead, state: options.state, targetDate: options.targetDate, startDate: options.startDate })
    }, program.opts<{ human?: boolean }>().human)
  });
  program.command("project-edit").argument("<projectId>").option("--name <name>", "New project name").option("--description <text>", "Project description").option("--description-file <path>", "Path to file containing description (overrides --description)").option("--lead <name|uuid>", "Lead user name or UUID").option("--state <state>", "Project state (Planned|Started|Paused|Completed|Canceled)").option("--target-date <date>", "Target date (YYYY-MM-DD)").option("--start-date <date>", "Start date (YYYY-MM-DD)").action(async (projectId: string, options: { name?: string; description?: string; descriptionFile?: string; lead?: string; state?: string; targetDate?: string; startDate?: string }) => {
    await runCommand(async () => {
      let description = options.description
      if (options.descriptionFile) {
        description = await fs.readFile(options.descriptionFile, "utf-8")
      }
      return editProject(projectId, { name: options.name, description, lead: options.lead, state: options.state, targetDate: options.targetDate, startDate: options.startDate })
    }, program.opts<{ human?: boolean }>().human)
  });
  program.command("project-attach-existing").argument("<issueId>").argument("<projectId>").option("--milestone <milestoneId>", "Milestone ID to attach in one shot").action(async (issueId: string, projectId: string, options: { milestone?: string }) => {
    await runCommand(async () => attachIssueToProjectById(issueId, projectId, options.milestone), program.opts<{ human?: boolean }>().human)
  });
  program.command("relations").argument("<id>").action(async (id: string) => {
    await runCommand(async () => listRelations(id), program.opts<{ human?: boolean }>().human);
  });
  program.command("block").argument("<id>").requiredOption("--blocked-by <issueId>").option("--yes").action(async (id: string, options: { blockedBy: string; yes?: boolean }) => {
    await runCommand(async () => createBlockingRelation(id, options.blockedBy, "blocked-by", !options.yes), program.opts<{ human?: boolean }>().human);
  });
  program.command("unblock").argument("<id>").requiredOption("--blocked-by <issueId>").action(async (id: string, options: { blockedBy: string }) => {
    await runCommand(async () => removeBlockingRelation(id, options.blockedBy), program.opts<{ human?: boolean }>().human);
  });
  program.command("parent").argument("<id>").argument("<parentId>").description("Set parent issue (makes <id> a sub-issue of <parentId>)").action(async (id: string, parentId: string) => {
    await runCommand(async () => setParentIssue(id, parentId), program.opts<{ human?: boolean }>().human);
  });

  program.command("unparent").argument("<id>").description("Remove parent relationship from issue").action(async (id: string) => {
    await runCommand(async () => removeParentIssue(id), program.opts<{ human?: boolean }>().human);
  });

  program.command("subtask").argument("<team>").argument("<title>").requiredOption("--parent <id>").action(async (team: string, title: string, options: { parent: string }) => {
    await runCommand(async () => {
      const teamId = await resolveTeamId(team);
      return createIssue({ teamId, title, parentId: options.parent });
    }, program.opts<{ human?: boolean }>().human);
  });
  program.command("children").argument("<id>").action(async (id: string) => {
    await runCommand(async () => (await getIssue(id)).children ?? [], program.opts<{ human?: boolean }>().human);
  });

  program.command("issue-move-team")
    .argument("<issueId>", "Issue identifier (e.g. LIFE-379)")
    .argument("<team>", "Target team key or UUID (e.g. AI)")
    .description("Move an issue to a different team")
    .action(async (issueId: string, team: string) => {
      await runCommand(async () => {
        const teamId = await resolveTeamId(team);
        return updateIssue(issueId, { teamId });
      }, program.opts<{ human?: boolean }>().human);
    });

  program.command("board").argument("<team>").action(async (team: string) => {
    await runCommand(async () => {
      const teamId = await resolveTeamId(team);
      return getBoard(teamId);
    }, program.opts<{ human?: boolean }>().human);
  });
  program.command("recently-done")
    .argument("<team>")
    .option("--days <n>", "Lookback window in days", "2")
    .description("Recently completed/canceled tickets in a team")
    .action(async (team: string, options: { days?: string }) => {
      await runCommand(async () => {
        const teamId = await resolveTeamId(team);
        const days = options.days ? Number(options.days) : 2;
        return getRecentlyDone(teamId, days);
      }, program.opts<{ human?: boolean }>().human);
    });
  program.command("review-queue").action(async () => {
    await runCommand(async () => getReviewQueue(), program.opts<{ human?: boolean }>().human);
  });
  program.command("stalled").argument("[days]").action(async (days: string | undefined) => {
    await runCommand(async () => getStalled(days ? Number(days) : 2), program.opts<{ human?: boolean }>().human);
  });
  program.command("comments", { hidden: true }).argument("<id>").option("--all").action(async (id: string, options: { all?: boolean }) => {
    await runCommand(async () => observeIssue(id, options.all, undefined), program.opts<{ human?: boolean }>().human);
  });

  program.command("upload").argument("<file>").option("--comment <issueId>").action(async (file: string, options: { comment?: string }) => {
    await runCommand(async () => uploadFile(file, options.comment), program.opts<{ human?: boolean }>().human);
  });

  program.command("fetch-image")
    .argument("<url>", "A uploads.linear.app / *.linear.app image URL")
    .option("-o, --out <path>", "Write the image to this path (default: a temp file)")
    .description("Download a Linear image attachment using the agent's API token (handles auth + redirect), then print the saved path")
    .action(async (url: string, options: { out?: string }) => {
      await runCommand(async () => fetchImage(url, options.out), program.opts<{ human?: boolean }>().human);
    });

  // --- New commands ---

  program.command("teams").option("--refresh").description("List all teams").action(async (options: { refresh?: boolean }) => {
    await runCommand(async () => listTeams(Boolean(options.refresh)), program.opts<{ human?: boolean }>().human);
  });

  program.command("notifications").option("--limit <n>").description("Unread notifications").action(async (options: { limit?: string }) => {
    await runCommand(async () => {
      const limit = options.limit ? Number(options.limit) : 25;
      const data = await linearGraphQL<NotificationsResponse>(
        `
          query Notifications($first: Int!) {
            notifications(first: $first) {
              nodes {
                id
                type
                readAt
                createdAt
                updatedAt
                ... on IssueNotification {
                  issue { id identifier title state { name } }
                }
                ... on ProjectNotification {
                  project { id name }
                }
              }
            }
          }
        `,
        { first: limit }
      );
      return data.notifications.nodes.filter((n: { readAt?: string | null }) => !n.readAt);
    }, program.opts<{ human?: boolean }>().human);
  });

  program.command("urgent").option("--limit <n>").description("High-priority issues (priority ≤ 2)").action(async (options: { limit?: string }) => {
    await runCommand(async () => {
      const limit = options.limit ? Number(options.limit) : 25;
      const data = await linearGraphQL<UrgentIssuesResponse>(
        `
          query UrgentIssues($first: Int!) {
            issues(first: $first, filter: {
              priority: { lte: 2, gte: 1 },
              state: { type: { nin: ["completed", "canceled"] } }
            }) {
              nodes {
                id identifier title priority url
                state { name type }
                assignee { name }
                team { key name }
              }
            }
          }
        `,
        { first: limit }
      );
      return data.issues.nodes;
    }, program.opts<{ human?: boolean }>().human);
  });

  program.command("standup").description("Daily standup summary").action(async () => {
    await runCommand(async () => {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      const data = await linearGraphQL<StandupResponse>(
        `
          query Standup($since: DateTimeOrDuration!) {
            todos: viewer {
              assignedIssues(first: 50, filter: { state: { name: { in: ["Todo"] } } }) {
                nodes { id identifier title priority team { key } }
              }
            }
            inProgress: viewer {
              assignedIssues(first: 50, filter: { state: { name: { in: ["In Progress"] } } }) {
                nodes { id identifier title priority team { key } }
              }
            }
            recentlyDone: viewer {
              assignedIssues(first: 50, filter: {
                state: { type: { eq: "completed" } },
                completedAt: { gte: $since }
              }) {
                nodes { id identifier title team { key } }
              }
            }
          }
        `,
        { since: sevenDaysAgo }
      );

      return {
        todos: data.todos.assignedIssues.nodes,
        inProgress: data.inProgress.assignedIssues.nodes,
        recentlyDone: data.recentlyDone.assignedIssues.nodes
      };
    }, program.opts<{ human?: boolean }>().human);
  });

  program.command("branch").argument("<id>").description("Get branch name for an issue").action(async (id: string) => {
    await runCommand(async () => {
      const issue = await getIssue(id);
      const data = await linearGraphQL<BranchResponse>(
        `
          query IssueBranch($id: String!) {
            issue(id: $id) {
              branchName
            }
          }
        `,
        { id: issue.id }
      );
      if (!data.issue?.branchName) {
        throw new Error(`No branch name for issue ${id}`);
      }
      return { identifier: issue.identifier, branchName: data.issue.branchName };
    }, program.opts<{ human?: boolean }>().human);
  });

  program.command("test").description("Run full round-trip test of Linear CLI").action(async () => {
    await linearTest();
  });

  // --- Delete commands ---

  program.command("delete").argument("<id>").description("Delete an issue").action(async (id: string) => {
    await runCommand(async () => deleteIssue(id), program.opts<{ human?: boolean }>().human);
  });

  program.command("delete-comment").argument("<commentId>").description("Delete a comment").action(async (commentId: string) => {
    await runCommand(async () => deleteComment(commentId), program.opts<{ human?: boolean }>().human);
  });

  program.command("verify-comment").argument("<commentId>").description("Verify a comment exists using strongly-consistent node lookup").action(async (commentId: string) => {
    const result = await verifyComment(commentId);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.exists) {
      process.exitCode = 1;
    }
  });

  // --- Label commands ---

  program.command("labels").option("--team <team>").description("List available labels for a team").action(async (options: { team?: string }) => {
    await runCommand(async () => listLabels(options.team), program.opts<{ human?: boolean }>().human);
  });

  program.command("label").argument("<id>").argument("<labelName...>").option("--team <team>").description("Add label(s) to an issue").action(async (id: string, labelNames: string[], options: { team?: string }) => {
    await runCommand(async () => addLabels(id, labelNames, options.team), program.opts<{ human?: boolean }>().human);
  });

  program.command("unlabel").argument("<id>").argument("<labelName...>").option("--team <team>").description("Remove label(s) from an issue").action(async (id: string, labelNames: string[], options: { team?: string }) => {
    await runCommand(async () => removeLabels(id, labelNames, options.team), program.opts<{ human?: boolean }>().human);
  });

  // --- Search command ---

  program.command("search").argument("<query>").option("--team <team>").option("--limit <n>").description("Search issues by text").action(async (query: string, options: { team?: string; limit?: string }) => {
    await runCommand(async () => {
      const teamId = options.team ? await resolveTeamId(options.team) : undefined;
      return searchIssues(query, teamId, options.limit ? Number(options.limit) : undefined);
    }, program.opts<{ human?: boolean }>().human);
  });

  // --- My blocked (hidden, backward compat) ---

  program.command("my-blocked", { hidden: true }).option("--limit <n>").description("Show issues assigned to me that are Blocked").action(async () => {
    await runCommand(() => handleQueue({ blocked: true }), program.opts<{ human?: boolean }>().human);
  });

  // --- Semantic commands ---

  // --- Semantic commands (kebab-case primary, camelCase aliases for compat) ---

  program.command("note").argument("<id>").option("--comment <msg>", `Comment body. ${INLINE_COMMENT_HELP}`).option("--comment-file <path>", "Read comment from file").option("--force-duplicate", "Bypass near-duplicate comment detection and force the post").description("Post a comment on an issue without changing state, delegate, or assignee").action(async (id: string, options: { comment?: string; commentFile?: string; forceDuplicate?: boolean }) => {
    await runCommand(async () => note(id, options), program.opts<{ human?: boolean }>().human);
  });

  program.command("undelegate").argument("<id>").option("--comment <msg>", INLINE_COMMENT_HELP).option("--comment-file <path>", "Read comment from file").option("--force-duplicate", "Bypass near-duplicate comment detection and force the post").description("Clear delegate and assignee without changing state").action(async (id: string, options: { comment?: string; commentFile?: string; forceDuplicate?: boolean }) => {
    await runCommand(async () => undelegate(id, options), program.opts<{ human?: boolean }>().human);
  });

  program.command("observe-issue").alias("observeIssue").argument("<id>").option("--all", "Include all comments instead of last 10").option("--since <timestamp>", "Only return comments created at or after this ISO timestamp").description("Read-only observation of an issue (no ownership change)").action(async (id: string, options: { all?: boolean; since?: string }) => {
    await runCommand(async () => observeIssue(id, options.all, options.since), program.opts<{ human?: boolean }>().human);
  });

  program.command("consider-work").alias("considerWork").argument("<id>").option("--force", "Allow reopening Done/Canceled issues or explicitly override the Backlog gate").description("Mark issue as being considered by agent (returns issue context)").action(async (id: string, options: { force?: boolean }) => {
    await runCommand(async () => considerWork(id, { force: options.force }), program.opts<{ human?: boolean }>().human);
  });

  program.command("refuse-work").alias("refuseWork").argument("<id>").argument("<delegate>", "agent display name in quotes, e.g. \"Astrid (CPO)\"").option("--comment <msg>", INLINE_COMMENT_HELP).option("--comment-file <path>", "Read comment from file").option("--force-duplicate", "Bypass near-duplicate comment detection and force the post").description("Refuse task and delegate to another agent").action(async (id: string, delegate: string, options: { comment?: string; commentFile?: string; forceDuplicate?: boolean }) => {
    await runCommand(async () => refuseWork(id, delegate, options), program.opts<{ human?: boolean }>().human);
  });

  program.command("begin-work").alias("beginWork").argument("<id>").description("Begin actively working on a task (idempotent)").action(async (id: string) => {
    await runCommand(async () => beginWork(id), program.opts<{ human?: boolean }>().human);
  });

  program.command("handoff-work").alias("handoffWork").argument("<id>").argument("<delegate>", "agent display name in quotes, e.g. \"Charles (CTO)\"").option("--comment <msg>", INLINE_COMMENT_HELP).option("--comment-file <path>", "Read comment from file").option("--force-duplicate", "Bypass near-duplicate comment detection and force the post").option("--force-matt-escalation", "Bypass Matt-escalation refusal guard (use only for legitimate escalations)").option("--review-handoff", "Mark as peer-review handoff: applies gate:agent-review label and prefixes comment with [Review Handoff]").description("Hand off task to another agent").action(async (id: string, delegate: string, options: { comment?: string; commentFile?: string; forceDuplicate?: boolean; forceMattEscalation?: boolean; reviewHandoff?: boolean }) => {
    await runCommand(async () => handoffWork(id, delegate, options), program.opts<{ human?: boolean }>().human);
  });

  program.command("complete").argument("<id>").option("--comment <msg>", INLINE_COMMENT_HELP).option("--comment-file <path>", "Read comment from file").option("--force-duplicate", "Bypass near-duplicate comment detection and force the post").description("Mark task as complete").action(async (id: string, options: { comment?: string; commentFile?: string; forceDuplicate?: boolean }) => {
    await runCommand(async () => complete(id, options), program.opts<{ human?: boolean }>().human);
  });

  program.command("needs-human").alias("needsHuman").argument("<id>").argument("<assignee>", "human display name in quotes, e.g. \"Matt Henry\"").option("--comment <msg>", INLINE_COMMENT_HELP).option("--comment-file <path>", "Read comment from file").option("--force-duplicate", "Bypass near-duplicate comment detection and force the post").option("--force-matt-escalation", "Bypass Matt-escalation refusal guard (use only for legitimate escalations)").description("Escalate to human for action").action(async (id: string, assignee: string, options: { comment?: string; commentFile?: string; forceDuplicate?: boolean; forceMattEscalation?: boolean }) => {
    await runCommand(async () => needsHuman(id, assignee, options), program.opts<{ human?: boolean }>().human);
  });

  program.command("park").alias("parkWork").argument("<id>").option("--comment <msg>", INLINE_COMMENT_HELP).option("--comment-file <path>", "Read comment from file").option("--force-duplicate", "Bypass near-duplicate comment detection and force the post").description("Move ticket to Backlog and clear ownership (intentional deprioritization)").action(async (id: string, options: { comment?: string; commentFile?: string; forceDuplicate?: boolean }) => {
    await runCommand(async () => parkWork(id, options), program.opts<{ human?: boolean }>().human);
  });

  program.command("manage").alias("manageWork").argument("<id>")
    .option("--comment <msg>", INLINE_COMMENT_HELP)
    .option("--comment-file <path>", "Read comment from file")
    .option("--force-duplicate", "Bypass near-duplicate comment detection and force the post")
    .option("--interval <duration>", "Stewardship wake interval written to the description (e.g. 10m, 2h, 1d). Default cadence is 30m when absent.")
    .description("Take stewardship of a ticket (Managing state). Connector wakes you on a cadence to re-review.")
    .action(async (id: string, options: { comment?: string; commentFile?: string; forceDuplicate?: boolean; interval?: string }) => {
      await runCommand(async () => manageWork(id, options), program.opts<{ human?: boolean }>().human);
    });

  // --- Dev-impl workflow semantic verbs (AI-1362) ---

  program.command("accept").argument("<id>")
    .argument("[target]", "Implementer body to assign (e.g. felix, sage)")
    .option("--comment <msg>", INLINE_COMMENT_HELP)
    .option("--comment-file <path>", "Read comment from file")
    .option("--force-duplicate", "Bypass near-duplicate comment detection and force the post")
    .description("Accept a ticket from intake into implementation (dev-impl: intake → implementation)")
    .action(async (id: string, target: string | undefined, options: { comment?: string; commentFile?: string; forceDuplicate?: boolean }) => {
      await runCommand(async () => accept(id, target, options), program.opts<{ human?: boolean }>().human);
    });

  program.command("submit").argument("<id>")
    .argument("[target]", "Reviewer body to assign (e.g. felix, noah)")
    .option("--comment <msg>", INLINE_COMMENT_HELP)
    .option("--comment-file <path>", "Read comment from file")
    .option("--force-duplicate", "Bypass near-duplicate comment detection and force the post")
    .description("Submit implementation for code review (dev-impl: implementation → code-review)")
    .action(async (id: string, target: string | undefined, options: { comment?: string; commentFile?: string; forceDuplicate?: boolean }) => {
      await runCommand(async () => submit(id, target, options), program.opts<{ human?: boolean }>().human);
    });

  program.command("approve").argument("<id>")
    .option("--comment <msg>", INLINE_COMMENT_HELP)
    .option("--comment-file <path>", "Read comment from file")
    .option("--force-duplicate", "Bypass near-duplicate comment detection and force the post")
    .description("Approve after code review (dev-impl: code-review → deployment)")
    .action(async (id: string, options: { comment?: string; commentFile?: string; forceDuplicate?: boolean }) => {
      await runCommand(async () => approve(id, options), program.opts<{ human?: boolean }>().human);
    });

  program.command("request-changes").argument("<id>")
    .option("--comment <msg>", "Feedback comment (required). " + INLINE_COMMENT_HELP)
    .option("--comment-file <path>", "Read comment from file (overrides --comment)")
    .option("--force-duplicate", "Bypass near-duplicate comment detection and force the post")
    .option("--target <name>", "Override default implementer target")
    .description("Request changes during code review (dev-impl: code-review → implementation). Requires --comment.")
    .action(async (id: string, options: { comment?: string; commentFile?: string; forceDuplicate?: boolean; target?: string }) => {
      await runCommand(async () => requestChanges(id, options), program.opts<{ human?: boolean }>().human);
    });

  program.command("deploy").argument("<id>")
    .option("--comment <msg>", INLINE_COMMENT_HELP)
    .option("--comment-file <path>", "Read comment from file")
    .option("--force-duplicate", "Bypass near-duplicate comment detection and force the post")
    .description("Deploy after approval (dev-impl: deployment → done)")
    .action(async (id: string, options: { comment?: string; commentFile?: string; forceDuplicate?: boolean }) => {
      await runCommand(async () => deploy(id, options), program.opts<{ human?: boolean }>().human);
    });

  program.command("reject").argument("<id>")
    .option("--comment <msg>", "Rejection reason (required). " + INLINE_COMMENT_HELP)
    .option("--comment-file <path>", "Read comment from file (overrides --comment)")
    .option("--force-duplicate", "Bypass near-duplicate comment detection and force the post")
    .option("--target <name>", "Override default implementer target")
    .description("Reject during deployment (dev-impl: deployment → implementation). Requires --comment.")
    .action(async (id: string, options: { comment?: string; commentFile?: string; forceDuplicate?: boolean; target?: string }) => {
      await runCommand(async () => reject(id, options), program.opts<{ human?: boolean }>().human);
    });

  program.command("escape").argument("<id>")
    .option("--comment <msg>", INLINE_COMMENT_HELP)
    .option("--comment-file <path>", "Read comment from file")
    .option("--force-duplicate", "Bypass near-duplicate comment detection and force the post")
    .description("Break-glass: escape the ticket out of the workflow (dev-impl: any → escape terminal)")
    .action(async (id: string, options: { comment?: string; commentFile?: string; forceDuplicate?: boolean }) => {
      await runCommand(async () => escape(id, options), program.opts<{ human?: boolean }>().human);
    });

  program.command("demote").argument("<id>")
    .option("--comment <msg>", INLINE_COMMENT_HELP)
    .option("--comment-file <path>", "Read comment from file")
    .option("--force-duplicate", "Bypass near-duplicate comment detection and force the post")
    .description("Demote a ticket out of dev-impl workflow (dev-impl: intake → ad-hoc)")
    .action(async (id: string, options: { comment?: string; commentFile?: string; forceDuplicate?: boolean }) => {
      await runCommand(async () => demote(id, options), program.opts<{ human?: boolean }>().human);
    });

  program.command("managing")
    .description("Tickets you are stewarding (Managing state)")
    .action(async () => {
      await runCommand(async () => getMyManaging(), program.opts<{ human?: boolean }>().human);
    });

  // Enhance unknown-option errors with usage hints by intercepting stderr output
  program.configureOutput({
    writeErr: (str: string) => {
      if (str.startsWith("error: unknown option")) {
        // Extract the subcommand from argv
        const argv = process.argv.slice(2);
        const subName = argv.find((a) => !a.startsWith("-"));
        if (subName) {
          const hint = buildUsageHint(program, subName);
          process.stderr.write(`${str.trimEnd()}${hint}\n`);
          process.exitCode = 1;
          return;
        }
      }
      process.stderr.write(str);
    },
  });

  await program.parseAsync(process.argv);
}

void main();
