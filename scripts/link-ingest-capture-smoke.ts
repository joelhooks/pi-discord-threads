import assert from "node:assert/strict";
import { buildLinkIngestCommandText, parsePrefixLinkIngestCommand } from "../src/link-ingest-command.js";
import { LINK_INGEST_EVENT_NAME, prepareLinkIngest } from "../src/link-ingest.js";
import type { LinkIngestConfig } from "../src/config.js";

const config: LinkIngestConfig = {
  enabled: true,
  inngestUrl: "http://127.0.0.1:8288",
  eventKeyEnv: "INNGEST_EVENT_KEY",
  eventKeySecretName: "inngest_event_key",
  eventKeyLeaseTtl: "12h",
  signingKeyEnv: "INNGEST_SIGNING_KEY",
  signingKeySecretName: "inngest_signing_key",
  signingKeyLeaseTtl: "12h",
  statusBridgeEnabled: true,
  defaultVisibility: "private",
  defaultSite: "joelclaw",
  wzrrdCandidate: false,
  requestTimeoutMs: 10_000,
};

const origin = {
  guildId: "guild-smoke",
  channelId: "channel-smoke",
  threadId: "thread-smoke",
  interactionId: "interaction-smoke",
  authorId: "author-smoke",
};

const captureBareText = buildLinkIngestCommandText({ url: "https://example.com" });
assert.equal(captureBareText, "https://example.com");
const captureBare = prepareLinkIngest({
  text: captureBareText,
  origin,
  config,
  createdAt: "2026-06-17T00:00:00.000Z",
});
assert.equal(captureBare.payload.name, LINK_INGEST_EVENT_NAME);
assert.equal(captureBare.normalizedUrl, "https://example.com/");
assert.equal(captureBare.context, undefined);
assert.equal(captureBare.payload.data.text, "https://example.com");
assert.equal("context" in captureBare.payload.data, false);
assert.equal(captureBare.payload.data.source, "discord");
assert.equal(captureBare.payload.data.sourceId, captureBare.sourceId);

const captureWithNoteText = buildLinkIngestCommandText({
  url: "https://example.com",
  note: "standalone research",
});
assert.equal(captureWithNoteText, "https://example.com standalone research");
const captureWithNote = prepareLinkIngest({
  text: captureWithNoteText,
  origin,
  config,
  createdAt: "2026-06-17T00:00:00.000Z",
});
assert.equal(captureWithNote.payload.name, LINK_INGEST_EVENT_NAME);
assert.equal(captureWithNote.context, "standalone research");
assert.equal(captureWithNote.payload.data.context, "standalone research");
assert.equal(captureWithNote.sourceId, captureBare.sourceId);

const ingestPrefix = parsePrefixLinkIngestCommand("ingest https://example.com existing ingest still works");
assert.deepEqual(ingestPrefix, {
  mode: "ingest",
  text: "https://example.com existing ingest still works",
});
const ingestPrepared = prepareLinkIngest({
  text: ingestPrefix.text,
  origin: { ...origin, interactionId: undefined, messageId: "message-smoke" },
  config,
  createdAt: "2026-06-17T00:00:00.000Z",
});
assert.equal(ingestPrepared.payload.name, LINK_INGEST_EVENT_NAME);
assert.equal(ingestPrepared.normalizedUrl, "https://example.com/");
assert.equal(ingestPrepared.context, "existing ingest still works");

assert.equal(parsePrefixLinkIngestCommand("https://example.com lightly annotated"), undefined);
assert.equal(parsePrefixLinkIngestCommand("capture https://example.com"), undefined);

console.log("link ingest capture smoke passed");
