import fs from "node:fs/promises";
import path from "node:path";

export interface MattEscalationRefusal {
  category: string;
  matchedText: string;
}

interface RefusalPattern {
  category: string;
  patterns: RegExp[];
}

const DEFAULT_PATTERNS: RefusalPattern[] = [
  {
    category: "gh-auth",
    patterns: [
      /gh\s+auth/i,
      /gh\s+cli/i,
      /github\s+auth/i,
      /auth.*broken/i,
      /auth.*expired/i,
      /\b401\b/,
      /re-?authenticate/i,
      /gh\s+auth\s+login/i,
    ],
  },
  {
    category: "pr-action",
    patterns: [
      /open\s+(the|this|a)\s+PR/i,
      /merge\s+(the|this)\s+PR/i,
      /review\s+(the|this)\s+PR/i,
      /PR\s+review/i,
    ],
  },
  {
    category: "ac-verification",
    patterns: [
      /verify\s+(the\s+)?AC\b/i,
      /AC\s+verification/i,
      /verify\s+(the\s+)?acceptance/i,
    ],
  },
  {
    category: "prioritization",
    patterns: [
      /prioriti[sz]e\s+(the\s+)?fix/i,
      /which\s+(one|of\s+these)\s+should/i,
      /fix\s+priority/i,
    ],
  },
  {
    category: "routing",
    patterns: [/which\s+agent/i, /\brouting\b/i, /who\s+owns/i],
  },
  {
    category: "credential-rotation",
    patterns: [/refresh.*token/i, /rotate.*credential/i],
  },
];

function loadEnvPatterns(): RefusalPattern[] {
  const raw = process.env.LINEAR_MATT_REFUSAL_PATTERNS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Array<{ category: string; patterns: string[] }>;
    return parsed.map(({ category, patterns }) => ({
      category,
      patterns: patterns.map((p) => new RegExp(p, "i")),
    }));
  } catch {
    process.stderr.write(
      "Warning: LINEAR_MATT_REFUSAL_PATTERNS is not valid JSON — extra patterns ignored.\n"
    );
    return [];
  }
}

export function checkMattEscalation(text: string): MattEscalationRefusal | null {
  const allPatterns = [...DEFAULT_PATTERNS, ...loadEnvPatterns()];
  for (const { category, patterns } of allPatterns) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        return { category, matchedText: match[0] };
      }
    }
  }
  return null;
}

export function isMattTarget(name: string): boolean {
  return /\bmatt\b/i.test(name);
}

export function formatRefusalError(
  issueId: string,
  refusal: MattEscalationRefusal
): string {
  return [
    `MATT_ESCALATION_REFUSED: ${refusal.category}`,
    `Reason "${refusal.matchedText}" matches forbidden category "${refusal.category}".`,
    `See ~/obsidian-vault/ai-systems/areas/agent-behavior/escalation-rules.md.`,
    `Default escalation surface is Ai. Use:`,
    `  linear handoff-work ${issueId} "Ai" --comment "[${refusal.category}] <one-line reason>"`,
    `If you genuinely need Matt (external blast / he named you / he's the conversational partner), pass --force-matt-escalation.`,
  ].join("\n");
}

export async function logRefusal(
  issueId: string,
  refusal: MattEscalationRefusal,
  forced: boolean
): Promise<void> {
  const logPath = path.join(
    process.env.HOME ?? "~",
    "obsidian-vault/ai-systems/areas/agent-behavior/escalation-pattern-log.md"
  );
  const timestamp = new Date().toISOString();
  const action = forced ? "FORCE-BYPASS" : "REFUSED";
  const line = `| ${timestamp} | CLI | ${issueId} | ${refusal.category} | \`${refusal.matchedText}\` | ${action} |\n`;
  try {
    await fs.appendFile(logPath, line);
  } catch {
    // Log failure is non-fatal
  }
}
