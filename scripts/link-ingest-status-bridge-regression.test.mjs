import assert from "node:assert/strict";
import test from "node:test";
import {
  renderLinkIngestCompletionMessage,
  shouldPostLinkIngestStatusToDiscord,
} from "../dist/link-ingest-status-bridge.js";

test("link ingest Discord status bridge only posts terminal user-facing updates", () => {
  for (const status of [
    "accepted",
    "classified",
    "archived",
    "video_metadata",
    "video_media",
    "audio_transcript",
    "article_extracted",
    "x_snapshot",
    "transcript_processed",
    "summarized",
    "ready",
  ]) {
    assert.equal(shouldPostLinkIngestStatusToDiscord(status), false, `${status} should be recorded without a Discord process card`);
  }

  assert.equal(shouldPostLinkIngestStatusToDiscord("indexed"), true);
  assert.equal(shouldPostLinkIngestStatusToDiscord("needs_human"), true);
  assert.equal(shouldPostLinkIngestStatusToDiscord("failed"), true);
});

test("completion message gives Joel a contextual summary instead of a process card", () => {
  const message = renderLinkIngestCompletionMessage({
    status: "indexed",
    title: "A useful AI workflow talk",
    sourceType: "video",
    normalizedUrl: "https://example.com/talk",
    summary: "The talk shows a small agent workflow that turns messy inputs into a durable project artifact.",
    highlights: [
      "The workflow starts with a human ack, not a giant dashboard.",
      "It keeps source receipts beside the final summary.",
    ],
    brainPath: ".brain/resources/captures/useful-ai-workflow.svx",
  });

  assert.match(message, /✅ Captured: A useful AI workflow talk/);
  assert.match(message, /Why it's interesting/);
  assert.match(message, /How you can use it/);
  assert.match(message, /Should you watch it\?/);
  assert.match(message, /Skim the summary first/);
  assert.doesNotMatch(message, /sourceId/);
  assert.doesNotMatch(message, /mentionId/);
});

test("needs-human message asks one useful question", () => {
  const message = renderLinkIngestCompletionMessage({
    status: "needs_human",
    title: "Weird private PDF",
    sourceType: "direct_media",
    contextSummary: "The archive succeeded, but the router needs a better source-specific extraction strategy.",
    question: "Should I OCR this PDF or just preserve the file as a receipt?",
    confidence: "low",
    brainPath: ".brain/resources/captures/weird-private-pdf.svx",
  });

  assert.match(message, /🤔 Capture needs a nudge: Weird private PDF/);
  assert.match(message, /Question/);
  assert.match(message, /OCR this PDF/);
  assert.match(message, /Confidence: low/);
  assert.doesNotMatch(message, /sourceId/);
  assert.doesNotMatch(message, /mentionId/);
});

test("failed completion message is still operator-useful", () => {
  const message = renderLinkIngestCompletionMessage({
    status: "failed",
    title: "Private source",
    sourceType: "article",
    failedStep: "article extract",
    reason: "HTTP 403 from the source.",
    manifestPath: ".brain/data/captures/source.json",
  });

  assert.match(message, /❌ Capture failed: Private source/);
  assert.match(message, /Failed at: article extract/);
  assert.match(message, /HTTP 403/);
  assert.match(message, /What to do/);
});
