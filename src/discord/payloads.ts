import { ButtonStyle, MessageFlags, type MessageCreateOptions } from "discord.js";
import type { PromptProgress } from "../progress-events.js";
import type { ThreadRecord } from "../registry.js";
import { isBridgeRecoveryPrompt } from "../recovery-prompt.js";
import { fallbackHudFrame, type RunHudFrame } from "../run-hud.js";

export interface ArchivedHudSnapshot {
  frame?: RunHudFrame;
  progress?: PromptProgress;
  elapsedMs?: number;
}

export type RichPayload = {
  content?: string;
  embeds?: MessageCreateOptions["embeds"];
  components?: MessageCreateOptions["components"];
  flags?: MessageFlags.IsComponentsV2;
};

type DiscordTopLevelComponent = NonNullable<MessageCreateOptions["components"]>[number];

type HudTone = "running" | "done" | "warning" | "error" | "interrupted";

const DiscordComponentType = {
  Button: 2,
  Section: 9,
  TextDisplay: 10,
  Separator: 14,
  Container: 17,
} as const;

const DiscordSeparatorSpacing = {
  Small: 1,
  Large: 2,
} as const;

const HUD_ACCENT: Record<HudTone, number> = {
  running: 0x5865f2,
  done: 0x57f287,
  warning: 0xf0b232,
  error: 0xed4245,
  interrupted: 0xf0b232,
};

export function buildWorkingPayload(record: ThreadRecord, _prompt: string, progress: PromptProgress): RichPayload {
  return buildHudPayload(record, fallbackHudFrame(progress), progress.elapsedMs ?? 0, progress.isError);
}

export function buildHudPayload(record: ThreadRecord, frame: RunHudFrame, _elapsedMs: number, isError = false): RichPayload {
  const normalized = normalizeHudFrame(frame);
  return buildHudCardPayload(record, {
    tone: isError ? "error" : normalized.risk ? "warning" : "running",
    stateLabel: isError ? "attention" : "active turn",
    header: normalized.header,
    now: normalized.now,
    progress: normalized.progress,
    signals: normalized.signals,
    risk: normalized.risk,
    next: normalized.next,
    footer: "final answer posts as a fresh reply below",
    expectedMessageId: record.activeRun?.placeholderDiscordMessageId,
  });
}

export function buildFinalPostedPayload(record: ThreadRecord): RichPayload {
  return buildArchivedHudPayload(record);
}

export function buildArchivedHudPayload(record: ThreadRecord, snapshot: ArchivedHudSnapshot = {}): RichPayload {
  const frame = snapshot.frame ?? (snapshot.progress ? fallbackHudFrame(snapshot.progress) : undefined);
  if (!frame) {
    return buildHudCardPayload(record, {
      tone: "done",
      stateLabel: "done",
      now: "Final answer posted below.",
      progress: ["✓ Pi turn finished", "✓ Discord reply sent", "· HUD persisted"],
      next: "Send the next message in this thread when you want to continue.",
      footer: "ready for the next turn",
      abortDisabled: true,
      inputText: false,
    });
  }

  const normalized = normalizeHudFrame(frame);
  return buildHudCardPayload(record, {
    tone: snapshot.progress?.isError ? "error" : "done",
    stateLabel: snapshot.progress?.isError ? "attention" : "done",
    header: normalized.header,
    now: normalized.now,
    progress: normalized.progress,
    signals: normalized.signals,
    risk: normalized.risk,
    next: normalized.risk ? undefined : normalized.next ?? "Final answer posted below.",
    footer: "final answer posted below; ready for the next turn",
    abortDisabled: true,
    inputText: false,
  });
}

export function formatQueuedText(mode: "steer" | "followUp", pendingCount: number): string {
  const label = mode === "followUp" ? "follow-up" : "steering";
  return `Queued as ${label}${pendingCount > 0 ? ` (${pendingCount} pending)` : ""}.`;
}

export function buildQueuedPayload(mode: "steer" | "followUp", pendingCount: number): RichPayload {
  return {
    content: formatQueuedText(mode, pendingCount),
    embeds: [],
    components: [],
  };
}

export function buildFinalizingBusyPayload(): RichPayload {
  return {
    content: "Previous turn is finalizing. Send this again in a moment if it does not post automatically.",
    embeds: [],
    components: [],
  };
}

export function buildQueuedRunPayload(record: ThreadRecord): RichPayload {
  return buildHudCardPayload(record, {
    tone: "warning",
    stateLabel: "queued",
    now: "Waiting for a run-control worker to claim this turn.",
    signals: "not active yet; no Pi turn is running for this card",
    progress: [
      "✓ run accepted by Redis",
      "→ waiting for worker claim",
      "· live events start after claim",
    ],
    next: "A worker will switch this card to active when it claims the lease.",
    footer: "final answer posts as a fresh reply below",
    expectedMessageId: record.activeRun?.placeholderDiscordMessageId,
  });
}

export function buildErrorPayload(record: ThreadRecord, error: string): RichPayload {
  return buildHudCardPayload(record, {
    tone: "error",
    stateLabel: "failed",
    now: "Pi run failed before Discord received a final answer.",
    progress: ["✗ run failed", "· session state preserved", "· send a new message to retry or continue"],
    risk: error,
    footer: "ESC disabled because this run is already terminal",
    abortDisabled: true,
  });
}

export function buildInterruptedRunPayload(record: ThreadRecord): RichPayload {
  const activeRun = record.activeRun;
  const promptPreview = activeRun?.promptPreview && !isBridgeRecoveryPrompt(activeRun.prompt)
    ? activeRun.promptPreview
    : "not recorded; use durable session history";
  return buildHudCardPayload(record, {
    tone: "interrupted",
    stateLabel: "interrupted",
    now: "Bridge restarted before Discord received a final answer.",
    signals: "terminal card; no live Pi turn is running",
    progress: [
      "⚠ run interrupted by bridge restart",
      `· request: ${promptPreview}`,
      `· session: ${record.sessionFile ?? activeRun?.sessionFile ?? "not created yet"}`,
    ],
    risk: "Send `continue` in this thread to recover from durable session history, or send a new prompt to continue from there.",
    footer: "ESC disabled because this run is already terminal",
    abortDisabled: true,
    inputText: false,
  });
}

function buildHudCardPayload(record: ThreadRecord, options: {
  tone: HudTone;
  stateLabel: string;
  header?: string;
  now: string;
  progress: string[];
  signals?: string;
  risk?: string;
  next?: string;
  footer: string;
  abortDisabled?: boolean;
  expectedMessageId?: string;
  inputText?: string | false;
}): RichPayload {
  const progress = fixedProgressRows(options.progress);
  const title = truncateForComponent(hudTitle(record), 90);
  const startedAt = hudStartedTimestamp(record);
  const subtitle = [`${options.stateLabel}${startedAt ? ` · started <t:${startedAt}:R>` : ""}`];
  if (record.workspaceName) subtitle.push(`workspace: ${record.workspaceName}`);
  const nowLines = [
    "**Now**",
    truncateForComponent(options.now, 650),
    options.signals ? `-# ${truncateForComponent(options.signals, 360)}` : undefined,
  ].filter(Boolean) as string[];
  const statusBlock = options.risk
    ? `**Watch**\n${truncateForComponent(options.risk, 650)}`
    : `**Next**\n${truncateForComponent(options.next ?? "continuing", 650)}`;

  return {
    content: "",
    embeds: [],
    flags: MessageFlags.IsComponentsV2,
    components: [containerComponent(options.tone, [
      sectionComponent(
        [`### ${title}`, `-# ${subtitle.join(" · ")}`].join("\n"),
        escButtonComponent(record.threadId, {
          abortDisabled: options.abortDisabled,
          expectedMessageId: options.expectedMessageId,
        }),
      ),
      separatorComponent(),
      textDisplayComponent(nowLines.join("\n")),
      textDisplayComponent(["**Progress**", ...progress.map((item) => truncateForComponent(item, 260))].join("\n")),
      textDisplayComponent(statusBlock),
      ...(options.inputText === false ? [] : [textDisplayComponent(options.inputText ?? "**Input**\nSend a message to steer this turn.\nPrefix with `follow-up:` to queue after the current turn.")]),
      textDisplayComponent(`-# ${truncateForComponent(options.footer, 280)}`),
    ])],
  };
}

function hudTitle(record: ThreadRecord): string {
  const sessionName = record.sessionName?.trim();
  if (sessionName && !/^Discord \d+$/i.test(sessionName)) return sessionName;
  return record.workspaceName?.trim() || "Pi turn";
}

function hudStartedTimestamp(record: ThreadRecord): number | undefined {
  const startedAt = record.activeRun?.startedAt ?? record.updatedAt;
  const millis = Date.parse(startedAt);
  if (!Number.isFinite(millis)) return undefined;
  return Math.floor(millis / 1000);
}

function fixedProgressRows(progress: string[]): string[] {
  const rows = progress.slice(0, 3).map((item) => item.trim()).filter(Boolean);
  while (rows.length < 3) rows.push("·");
  return rows;
}

function containerComponent(tone: HudTone, components: DiscordTopLevelComponent[]): DiscordTopLevelComponent {
  return {
    type: DiscordComponentType.Container,
    accent_color: HUD_ACCENT[tone],
    components,
  } as DiscordTopLevelComponent;
}

function sectionComponent(content: string, accessory: ReturnType<typeof escButtonComponent>): DiscordTopLevelComponent {
  return {
    type: DiscordComponentType.Section,
    components: [textDisplayComponent(content)],
    accessory,
  } as DiscordTopLevelComponent;
}

function textDisplayComponent(content: string): DiscordTopLevelComponent {
  return {
    type: DiscordComponentType.TextDisplay,
    content: truncateForComponent(content, 3_800),
  } as DiscordTopLevelComponent;
}

function separatorComponent(): DiscordTopLevelComponent {
  return {
    type: DiscordComponentType.Separator,
    divider: true,
    spacing: DiscordSeparatorSpacing.Small,
  } as DiscordTopLevelComponent;
}

function escButtonComponent(threadId: string, options: { abortDisabled?: boolean; expectedMessageId?: string } = {}) {
  const disabled = options.abortDisabled === true || !options.expectedMessageId;
  return {
    type: DiscordComponentType.Button,
    custom_id: options.expectedMessageId ? `pi:abort:${threadId}|${options.expectedMessageId}` : `pi:abort:${threadId}`,
    label: "ESC",
    style: ButtonStyle.Danger,
    disabled,
  };
}

function truncateForComponent(value: string, maxChars: number): string {
  const clean = value.trim() || "-";
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(0, maxChars - 1))}…`;
}

function normalizeHudFrame(frame: RunHudFrame): RunHudFrame {
  const progress = Array.isArray(frame.progress)
    ? frame.progress.map((item) => String(item).trim()).filter(Boolean).slice(0, 3)
    : [];
  return {
    header: String(frame.header || "Pi is working").trim() || "Pi is working",
    now: String(frame.now || "working through the task").trim() || "working through the task",
    progress: progress.length > 0 ? progress : ["→ working"],
    signals: frame.signals ? String(frame.signals).trim() : undefined,
    risk: frame.risk ? String(frame.risk).trim() : undefined,
    next: frame.next ? String(frame.next).trim() : undefined,
  };
}
