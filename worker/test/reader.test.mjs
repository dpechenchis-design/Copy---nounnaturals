import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READER_CONFIG } from "../../src/lib/ai/reader/index.ts";
import { readClip } from "../src/clip.ts";
import { runLoop } from "../src/loop.ts";
import { summarisePending } from "../src/summaries.ts";
import { finishPayload, folderFilter, callRow } from "../src/db.ts";
import { extractAudio, ffmpegArgs } from "../src/audio.ts";
import { workerEnvFrom } from "../src/env.ts";
import { scrub } from "../src/log.ts";
import { restClient, RestError } from "../src/rest.ts";

/* The whole reader on a pretend database, a pretend Drive and a pretend Gemini: no network, no keys. The sound
   tests run the real ffmpeg on files it makes itself, and are skipped where ffmpeg is not installed. */

const CARD = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const JOB = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", spaceId: "s1", batchId: "b1", driveFileId: "drv1", homeFolderId: "home1", fileName: "IMG_1.MOV", mimeType: "video/quicktime", sizeBytes: 1000, durationMs: 60_000, attempts: 1, transcript: null };

const interaction = (text, usage) => new Response(JSON.stringify({ id: "i", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text }] }], usage }), { status: 200 });
const matchAnswer = (pct, card = "c1") => JSON.stringify({ title: "Bar lasts longer", summary: "She says one bar outlasts three bottles.", matches: pct === null ? [] : [{ card, confidence: pct, reason: "Says the hook" }], new_card: pct === null ? "A clip about storage" : null });

/** a pretend Gemini: the Files API upload (two requests), then answers from the list for each interaction */
function fakeGemini(answers) {
  const asked = [];
  const fetch = async (url, init = {}) => {
    const u = String(url);
    asked.push({ url: u, method: init.method ?? "GET" });
    if (u.endsWith("/upload/v1beta/files")) return new Response("{}", { status: 200, headers: { "x-goog-upload-url": "https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=1" } });
    if (u.includes("upload_id=")) return new Response(JSON.stringify({ file: { name: "files/f1", uri: "https://g/files/f1" } }), { status: 200 });
    if (init.method === "DELETE") return new Response("{}", { status: 200 });
    const next = answers.shift();
    if (!next) throw new Error("no answer left");
    return next;
  };
  return { deps: { apiKey: "k", fetch, sleep: async () => {} }, asked };
}

function fakeDb(over = {}) {
  const calls = [];
  let run = 0;
  const db = {
    calls,
    claim: async () => [],
    spendToday: async () => ({ capUsd: 5, spentUsd: 0 }),
    reserve: async (agent, estUsd) => {
      calls.push(["reserve", agent, estUsd]);
      return { ok: true, runId: "run-" + ++run, capUsd: 5, spentUsd: estUsd };
    },
    candidates: async () => [{ id: CARD, title: "Bar against bottle", hook: "This bar lasts longer" }, { id: OTHER, title: "Hard water" }],
    finish: async (clipId, input) => {
      calls.push(["finish", input.outcome, input]);
      return { ok: true, status: "done", reason: null, batchId: "b1", batchOpen: 0, moveId: null };
    },
    settings: async () => ({}),
    filingContext: async () => ({ space: { id: "s1", name: "Noun" }, week: { id: "w1", spaceId: "s1", name: "Week 2", startsOn: "2026-11-09" }, weekCards: [{ id: CARD, plannedOn: "2026-11-11", title: "Bar against bottle" }], homePurpose: "new_uploads", movedByAnother: false }),
    pendingDrops: async () => [],
    dropFiles: async () => [],
    folderRecord: async () => null,
    saveSummary: async (...a) => void calls.push(["saveSummary", ...a]),
    heartbeat: async (running) => void calls.push(["heartbeat", running]),
    folders: { saved: async () => null, save: async () => {}, forget: async () => {}, refile: async () => {} },
    ...over,
  };
  return db;
}

const APPLIED = { cardId: CARD, moved: true, fromFolderId: "home1", toFolderId: "raw1", shortcutId: "sc1" };
function fakeDrive(over = {}) {
  const filed = [];
  return {
    filed,
    token: async () => "ya29.pretend",
    mediaUrl: (id) => "https://www.googleapis.com/drive/v3/files/" + id + "?alt=media",
    info: async () => ({ ok: true, name: "IMG_1.MOV", mimeType: "video/quicktime", durationMs: 60_000, sizeBytes: 1000 }),
    file: async (job, ctx, cardId) => {
      filed.push(cardId);
      return { ok: true, applied: { ...APPLIED, cardId } };
    },
    unfiled: [],
    async unfile(job, applied) {
      this.unfiled.push(applied.cardId);
      return { ok: true };
    },
    ...over,
  };
}

const LOUD = { hasAudioStream: true, seconds: 60, maxDb: -3, meanDb: -22, silentSeconds: 2 };
function fakeAudio(result) {
  const state = { ran: 0, cleaned: 0, input: null };
  const cleanup = async () => void state.cleaned++;
  const fn = async (input) => {
    state.ran++;
    state.input = input;
    if (result) return typeof result === "function" ? result(cleanup) : result;
    return { kind: "ok", probe: LOUD, seconds: 60, mimeType: "audio/flac", cleanup, pieces: [{ path: "x", bytes: 4, seconds: 60, blob: async () => new Blob([new Uint8Array([1, 2, 3, 4])]) }] };
  };
  fn.state = state;
  return fn;
}

const logs = [];
const log = (severity, message, fields) => void logs.push({ severity, message, ...fields });
const TR_USAGE = { total_input_tokens: 1920, total_output_tokens: 150, input_tokens_by_modality: [{ modality: "audio", tokens: 1920 }] };
const H_USAGE = { total_input_tokens: 1800, total_output_tokens: 200 };

function setup({ gemini = [], db, drive, audio } = {}) {
  const g = fakeGemini(gemini);
  const d = fakeDb(db);
  const dr = fakeDrive(drive);
  const a = fakeAudio(audio);
  return { deps: { db: d, drive: dr, gemini: g.deps, cfg: READER_CONFIG, audio: a, log, sleep: async () => {} }, db: d, drive: dr, audio: a, asked: g.asked };
}
const finishes = (db) => db.calls.filter((c) => c[0] === "finish").map((c) => c[1]);
const lastFinish = (db) => db.calls.filter((c) => c[0] === "finish").at(-1)[2];

/* ---------- one clip ---------- */

test("a sure match: transcribed, saved at once, matched, filed in Drive, saved with both costs", async () => {
  const t = setup({ gemini: [interaction("This bar lasts longer than three bottles.", TR_USAGE), interaction(matchAnswer(94), H_USAGE)] });
  const end = await readClip(t.deps, JOB);
  assert.deepEqual([end.end, end.auto, end.batchReady], ["done", true, "b1"]);
  assert.deepEqual(finishes(t.db), ["transcribed", "done"], "the transcript is saved before the match is asked");
  assert.deepEqual(t.db.calls.filter((c) => c[0] === "reserve").map((c) => c[1]), ["clip_indexer", "clip_matcher"]);
  assert.equal(t.db.calls.find((c) => c[0] === "reserve")[2], 0.005, "one minute of sound is held at $0.005");
  assert.deepEqual(t.drive.filed, [CARD]);
  const done = lastFinish(t.db);
  assert.deepEqual(done.applied, APPLIED);
  assert.deepEqual(done.suggestions, [{ cardId: CARD, pct: 94, reason: "Says the hook" }]);
  assert.equal(done.title, "Bar lasts longer");
  assert.equal(done.index.decision, "auto");
  assert.deepEqual([done.calls[0].tool, done.calls[0].runId, done.calls[0].costUsd], ["match", "run-2", 0.0042]);
  const tr = t.db.calls.find((c) => c[1] === "transcribed")[2];
  assert.deepEqual([tr.calls[0].tool, tr.calls[0].runId, tr.calls[0].costUsd, tr.durationMs], ["transcribe", "run-1", 0.0056, 60_000]);
  assert.equal(end.usd, 0.0098);
  assert.equal(t.audio.state.cleaned, 1, "the sound file is removed");
  assert.equal(t.asked.filter((a) => a.method === "DELETE").length, 1, "and taken out of Google's Files API");
  assert.equal(t.audio.state.input.authorization, "Bearer ya29.pretend");
  /* Hydrogen got text only */
  assert.equal(t.asked.filter((a) => a.url.endsWith("/v1beta/interactions")).length, 2);
});

test("under 90%: nothing is filed, the suggestion waits for a tap", async () => {
  const t = setup({ gemini: [interaction("This bar lasts longer than three bottles.", TR_USAGE), interaction(matchAnswer(72), H_USAGE)] });
  const end = await readClip(t.deps, JOB);
  assert.deepEqual([end.end, end.auto], ["done", false]);
  assert.deepEqual(t.drive.filed, []);
  assert.equal(lastFinish(t.db).applied, null);
  assert.equal(lastFinish(t.db).index.decision, "suggest");
});

test("no card fits: the idea for a new card is kept", async () => {
  const t = setup({ gemini: [interaction("We talk about where to store the bar.", TR_USAGE), interaction(matchAnswer(null), H_USAGE)] });
  await readClip(t.deps, JOB);
  const done = lastFinish(t.db);
  assert.deepEqual(done.suggestions, []);
  assert.equal(done.index.use, "A clip about storage");
  assert.equal(done.index.decision, "none");
});

test("no sound track, or silence: a No sound video, nothing sent to Gemini, $0", async () => {
  for (const audio of [(cleanup) => ({ kind: "no_track", probe: { ...LOUD, hasAudioStream: false }, cleanup }), (cleanup) => ({ kind: "ok", probe: { ...LOUD, maxDb: -91, meanDb: -91 }, seconds: 60, mimeType: "audio/flac", pieces: [{ path: "x", bytes: 4, seconds: 60, blob: async () => new Blob(["x"]) }], cleanup })]) {
    const t = setup({ audio });
    const end = await readClip(t.deps, JOB);
    assert.deepEqual([end.end, end.usd], ["no_sound", 0]);
    assert.deepEqual(finishes(t.db), ["no_speech"]);
    assert.deepEqual(lastFinish(t.db).calls, []);
    assert.equal(t.asked.length, 0, "Gemini was never asked");
    assert.equal(t.db.calls.filter((c) => c[0] === "reserve").length, 0, "no money was held");
    assert.equal(t.audio.state.cleaned, 1);
  }
});

test("sound but nobody speaks: paid once for Transcribe, no matching call, a No sound video", async () => {
  const t = setup({ gemini: [interaction(" ", TR_USAGE)] });
  const end = await readClip(t.deps, JOB);
  assert.equal(end.end, "no_sound");
  assert.deepEqual(finishes(t.db), ["no_speech"]);
  assert.equal(lastFinish(t.db).calls[0].costUsd, 0.0056);
  assert.equal(t.asked.filter((a) => a.url.endsWith("/v1beta/interactions")).length, 1);
});

test("the daily cap: the clip waits and ffmpeg is not even started", async () => {
  const full = setup({ db: { spendToday: async () => ({ capUsd: 5, spentUsd: 5 }) } });
  assert.equal((await readClip(full.deps, JOB)).end, "held");
  assert.equal(full.audio.state.ran, 0);
  assert.deepEqual(finishes(full.db), ["held"]);

  /* the database is the judge: it may say no even when the first look said yes */
  const late = setup({ db: { reserve: async () => ({ ok: false, runId: null, capUsd: 5, spentUsd: 5 }) } });
  assert.equal((await readClip(late.deps, JOB)).end, "held");
  assert.equal(late.asked.length, 0);
  assert.equal(late.audio.state.cleaned, 1);
});

test("a retry finds its transcript and never pays for it twice", async () => {
  const t = setup({ gemini: [interaction(matchAnswer(95), H_USAGE)] });
  const end = await readClip(t.deps, { ...JOB, transcript: "This bar lasts longer than three bottles.", attempts: 2 });
  assert.equal(end.end, "done");
  assert.equal(t.audio.state.ran, 0, "the sound is not read again");
  assert.deepEqual(t.db.calls.filter((c) => c[0] === "reserve").map((c) => c[1]), ["clip_matcher"]);
  assert.deepEqual(finishes(t.db), ["done"]);
});

test("the cap is reached after the transcript: the clip waits, the transcript stays saved", async () => {
  let n = 0;
  const t = setup({ gemini: [interaction("This bar lasts longer than three bottles.", TR_USAGE)], db: { reserve: async () => (++n === 1 ? { ok: true, runId: "run-1", capUsd: 5, spentUsd: 4.999 } : { ok: false, runId: null, capUsd: 5, spentUsd: 5 }) } });
  const end = await readClip(t.deps, JOB);
  assert.deepEqual([end.end, end.usd], ["held", 0.0056]);
  assert.deepEqual(finishes(t.db), ["transcribed", "held"]);
});

test("the file is gone from Drive: the clip is marked removed, nothing is paid", async () => {
  const t = setup({ drive: { info: async () => ({ ok: false, kind: "gone" }) } });
  assert.equal((await readClip(t.deps, JOB)).end, "gone");
  assert.deepEqual(finishes(t.db), ["gone"]);
  const t2 = setup({ audio: { kind: "gone" } });
  assert.equal((await readClip(t2.deps, JOB)).end, "gone");
});

test("failures hand the clip back for another try, with what was paid", async () => {
  const drive = setup({ drive: { info: async () => ({ ok: false, kind: "down" }) } });
  assert.equal((await readClip(drive.deps, JOB)).end, "retry");
  assert.deepEqual(finishes(drive.db), ["retry"]);

  const ff = setup({ audio: { kind: "fail", detail: "ffmpeg stopped with code 1." } });
  assert.equal((await readClip(ff.deps, JOB)).detail, "ffmpeg stopped with code 1.");

  const quota = setup({ gemini: [new Response(JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "bad key AIzaSyA-not-a-real-key-123456" } }), { status: 403 })] });
  const q = await readClip(quota.deps, JOB);
  assert.equal(q.end, "retry");
  assert.doesNotMatch(JSON.stringify(quota.db.calls), /AIzaSyA/, "a key in Google's words never reaches the database");
  const r = lastFinish(quota.db);
  assert.deepEqual([r.calls[0].runId, r.calls[0].ok, r.calls[0].costUsd], ["run-1", false, 0], "the held money is given back");
  assert.equal(quota.audio.state.cleaned, 1);

  const junk = setup({ gemini: [interaction("This bar lasts longer than three bottles.", TR_USAGE), interaction("It is the first card!", H_USAGE)] });
  const j = await readClip(junk.deps, JOB);
  assert.equal(j.end, "retry");
  assert.deepEqual(finishes(junk.db), ["transcribed", "retry"]);
  assert.ok(lastFinish(junk.db).calls[0].costUsd > 0, "an unreadable answer was still paid for");
  assert.deepEqual(junk.drive.filed, [], "nothing is filed on an answer that could not be read");
});

test("Drive says no to filing: tried twice, then the sure match waits as a suggestion", async () => {
  let n = 0;
  const flaky = setup({ gemini: [interaction("This bar lasts longer than three bottles.", TR_USAGE), interaction(matchAnswer(96), H_USAGE)], drive: { file: async () => (++n === 1 ? { ok: false, kind: "drive", detail: "down" } : { ok: true, applied: APPLIED }) } });
  assert.equal((await readClip(flaky.deps, JOB)).auto, true);

  const down = setup({ gemini: [interaction("This bar lasts longer than three bottles.", TR_USAGE), interaction(matchAnswer(96), H_USAGE)], drive: { file: async () => ({ ok: false, kind: "drive", detail: "Google Drive did not take the change (down)." }) } });
  const end = await readClip(down.deps, JOB);
  assert.deepEqual([end.end, end.auto], ["done", false]);
  const done = lastFinish(down.db);
  assert.equal(done.applied, null);
  assert.equal(done.index.decision, "suggest");
  assert.equal(done.suggestions[0].pct, 96, "the suggestion is kept, one tap files it");

  const gone = setup({ gemini: [interaction("This bar lasts longer than three bottles.", TR_USAGE), interaction(matchAnswer(96), H_USAGE)], drive: { file: async () => ({ ok: false, kind: "gone", detail: "" }) } });
  assert.equal((await readClip(gone.deps, JOB)).end, "gone");
});

test("another reader already moved the clip on: this one stops without filing", async () => {
  const t = setup({ gemini: [interaction("This bar lasts longer than three bottles.", TR_USAGE)], db: { finish: async () => ({ ok: false, status: "done", reason: "not_running", batchId: null, batchOpen: null, moveId: null }) } });
  const end = await readClip(t.deps, JOB);
  assert.deepEqual([end.end, end.detail], ["lost", "not_running"]);
  assert.deepEqual(t.drive.filed, []);
});

/* ---------- the loop ---------- */

test("the loop reads four at a time, says it is alive, and stops when the queue is empty", async () => {
  const queue = Array.from({ length: 10 }, (_, i) => ({ ...JOB, id: "clip-" + i }));
  let inFlight = 0;
  let most = 0;
  const beats = [];
  const asked = [];
  const totals = await runLoop({
    db: { claim: async (limit) => (asked.push(limit), queue.splice(0, limit)), finish: async () => ({}), heartbeat: async (r) => void beats.push(r) },
    readOne: async (job) => {
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (job.id === "clip-3") throw new Error("database hiccup");
      return { clipId: job.id, end: job.id === "clip-5" ? "no_sound" : "done", usd: 0.01, auto: job.id === "clip-1", batchReady: null, detail: null };
    },
    summarise: async () => ({ written: 1, usd: 0.01, capReached: false }),
    log: () => {},
    concurrency: 4,
    leaseMinutes: 30,
    deadline: Date.now() + 60_000,
    pollMs: 1,
    heartbeatMs: 0,
  });
  assert.equal(most, 4);
  assert.ok(asked.every((n) => n >= 1 && n <= 4));
  assert.deepEqual([totals.clips, totals.done, totals.noSound, totals.retried, totals.auto, totals.stopped], [10, 8, 1, 1, 1, "empty"]);
  assert.equal(totals.summaries, 2);
  assert.equal(beats[0], true);
  assert.equal(beats.at(-1), false, "the last word is: not running");
  assert.ok(beats.length > 2);
});

test("the loop stops taking clips when the cap is reached or its time is up, and still says it stopped", async () => {
  const beats = [];
  const base = { finish: async () => ({}), heartbeat: async (r) => void beats.push(r) };
  let claims = 0;
  const cap = await runLoop({ db: { ...base, claim: async () => (++claims === 1 ? [JOB] : [{ ...JOB, id: "x" }]) }, readOne: async (job) => ({ clipId: job.id, end: "held", usd: 0, auto: false, batchReady: null, detail: null }), summarise: async () => ({ written: 0, usd: 0, capReached: false }), log: () => {}, concurrency: 1, leaseMinutes: 30, deadline: Date.now() + 60_000, pollMs: 1 });
  assert.deepEqual([cap.stopped, cap.held, claims], ["cap", 1, 1]);
  const late = await runLoop({ db: { ...base, claim: async () => [JOB] }, readOne: async () => assert.fail("no clip is taken after the time is up"), summarise: async () => ({ written: 0, usd: 0, capReached: false }), log: () => {}, concurrency: 4, leaseMinutes: 30, deadline: Date.now() - 1, pollMs: 1 });
  assert.equal(late.stopped, "time");
  await assert.rejects(runLoop({ db: { ...base, claim: async () => Promise.reject(new RestError(404, "PGRST202", "no such function")) }, readOne: async () => {}, summarise: async () => ({ written: 0, usd: 0, capReached: false }), log: () => {}, concurrency: 4, leaseMinutes: 30, deadline: Date.now() + 1000 }), (e) => e.notThere === true);
  assert.equal(beats.at(-1), false);
});

/* ---------- summaries ---------- */

test("a finished drop gets its two lines once; a quiet drop costs nothing; a busy drop waits", async () => {
  const files = { busy: [{ name: "a", kind: "video", status: "running", read: false }], quiet: [{ name: "a", kind: "video", noSound: true, status: "done", read: false }, { name: "b", kind: "photo", status: "done", read: false }], said: [{ name: "a", kind: "video", title: "Bar lasts longer", summary: "x", status: "done", read: true }], folder: [{ name: "a", kind: "video", title: "Shower b roll", summary: "y", status: "done", read: true }] };
  const g = fakeGemini([interaction('{"summary": "One talking clip about the bar."}', { total_input_tokens: 500, total_output_tokens: 20 }), interaction('{"summary": "Shower clips - mostly b roll."}', { total_input_tokens: 500, total_output_tokens: 20 })]);
  const db = fakeDb({
    pendingDrops: async () => [{ id: "busy", origin: "upload", driveFolderId: null }, { id: "quiet", origin: "upload", driveFolderId: null }, { id: "said", origin: "files", driveFolderId: "f" }, { id: "folder", origin: "folder_read", driveFolderId: "drvF" }],
    dropFiles: async (id) => files[id],
    folderRecord: async (id) => (id === "drvF" ? { id: "row-F", name: "Shower" } : null),
  });
  const pass = await summarisePending({ db, gemini: g.deps, cfg: READER_CONFIG, log });
  const saved = db.calls.filter((c) => c[0] === "saveSummary").map((c) => [c[1], c[2], c[3], c[4].length]);
  assert.deepEqual(saved, [
    ["drop", "quiet", "One video with no sound and one photo.", 0],
    ["drop", "said", "One talking clip about the bar.", 1],
    ["drop", "folder", "Shower clips, mostly b roll.", 1],
    ["folder", "row-F", "Shower clips, mostly b roll.", 0],
  ]);
  assert.equal(pass.written, 3);
  assert.ok(pass.usd > 0 && pass.usd < 0.01);
  assert.equal(db.calls.filter((c) => c[0] === "reserve").length, 2, "the quiet drop held no money");

  const capped = fakeDb({ pendingDrops: async () => [{ id: "said", origin: "upload", driveFolderId: null }], dropFiles: async () => files.said, spendToday: async () => ({ capUsd: 5, spentUsd: 5 }) });
  assert.deepEqual(await summarisePending({ db: capped, gemini: fakeGemini([]).deps, cfg: READER_CONFIG, log }), { written: 0, usd: 0, capReached: true });
});

/* ---------- the database's shapes ---------- */

test("what is sent to finish_clip_index and reader_record_calls has the migration's names", () => {
  const call = { tool: "match", provider: "google", model: "gemini-4-hydrogen", ok: true, tokensIn: 10, tokensOut: 5, costUsd: 0.0042, inputSummary: "2 cards", outputSummary: "1 cards", error: null, promptVersion: "v1", runId: "run-9" };
  assert.deepEqual(callRow(call), { run_id: "run-9", tool_name: "match", provider_key: "google", model_key: "gemini-4-hydrogen", cost_usd: 0.0042, tokens_in: 10, tokens_out: 5, input_summary: "2 cards (prompt v1)", output_summary: "1 cards", error: "" });
  assert.deepEqual(finishPayload({ outcome: "held" }), { outcome: "held" });
  assert.deepEqual(finishPayload({ outcome: "transcribed", transcript: "a b c", durationMs: 1000, calls: [] }), { outcome: "transcribed", transcript: "a b c", language: null, words: null, duration_ms: 1000, calls: [] });
  const done = finishPayload({ outcome: "done", title: "T", summary: null, index: { use: null }, suggestions: [{ cardId: CARD, pct: 94, reason: null }], model: { provider: "google", model: "gemini-4-hydrogen" }, applied: APPLIED, calls: [call] });
  assert.deepEqual(done.suggestions, [{ card_id: CARD, confidence: 94, reason: "" }]);
  assert.deepEqual(done.applied, { card_id: CARD, moved: true, from_drive_folder_id: "home1", to_drive_folder_id: "raw1", drive_shortcut_id: "sc1" });
  assert.deepEqual(done.model, { provider_key: "google", model_key: "gemini-4-hydrogen" });
  assert.equal("applied" in finishPayload({ outcome: "done", title: null, summary: null, index: {}, suggestions: [], model: { provider: "g", model: "m" }, applied: null, calls: [] }), false);

  assert.deepEqual(folderFilter({ purpose: "card", name: "x", day: "2026-11-11", spaceId: "s", weekId: "w", cardId: "c" }), { purpose: "eq.card", deleted_at: "is.null", card_id: "eq.c" });
  assert.deepEqual(folderFilter({ purpose: "week_raw", name: "Raw", day: null, spaceId: "s", weekId: "w" }), { purpose: "eq.week_raw", deleted_at: "is.null", week_id: "eq.w" });
  assert.deepEqual(folderFilter({ purpose: "day", name: "Wed", day: "2026-11-11", spaceId: "s", weekId: "w" }), { purpose: "eq.day", deleted_at: "is.null", week_id: "eq.w", day: "eq.2026-11-11", card_id: "is.null" });
  assert.deepEqual(folderFilter({ purpose: "space", name: "Noun", day: null, spaceId: "s" }), { purpose: "eq.space", deleted_at: "is.null", space_id: "eq.s", card_id: "is.null" });
  assert.equal(folderFilter({ purpose: "team", name: "B roll", day: null, spaceId: "s" }), null);
});

test("settings are read by name, keys never reach a log line or an address", async () => {
  assert.deepEqual(workerEnvFrom({}).missing, ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GEMINI_API_KEY", "GOOGLE_DRIVE_SHARED_DRIVE_ID"]);
  const ok = workerEnvFrom({ SUPABASE_URL: "https://abc.supabase.co/", SUPABASE_SERVICE_ROLE_KEY: "k", GEMINI_API_KEY: "g", GOOGLE_DRIVE_SHARED_DRIVE_ID: "0AAbcdefghijkUk9PVA", READER_CONCURRENCY: "99" });
  assert.equal(ok.ok, true);
  assert.deepEqual([ok.env.supabaseUrl, ok.env.concurrency, ok.env.maxMinutes, ok.env.leaseMinutes], ["https://abc.supabase.co", 4, 50, 30]);
  assert.equal(workerEnvFrom({ SUPABASE_URL: "http://x", SUPABASE_SERVICE_ROLE_KEY: "k", GEMINI_API_KEY: "g", GOOGLE_DRIVE_SHARED_DRIVE_ID: "0AAbcdefghijkUk9PVA" }).ok, false);
  assert.equal(scrub("Authorization: Bearer ya29.a0AfH6 and AIzaSyA1234567890abcdef and sb_secret_abc123"), "Authorization: [hidden] and [hidden] and [hidden]");
  assert.equal(scrub("key AQ.Ab8RN6made-up_key.123 was refused"), "key [hidden] was refused", "Google's newer key format (AQ.) is hidden too");

  const seen = [];
  const rest = restClient("https://abc.supabase.co", "sb_secret_key", async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify([{ ok: true }]), { status: 200 });
  });
  await rest.rpc("claim_clip_jobs", { p_limit: 4, p_lease_minutes: 30 });
  await rest.select("raw_clips", { select: "id", deleted_at: "is.null" });
  assert.equal(seen[0].url, "https://abc.supabase.co/rest/v1/rpc/claim_clip_jobs");
  assert.equal(seen[1].url, "https://abc.supabase.co/rest/v1/raw_clips?select=id&deleted_at=is.null");
  assert.ok(seen.every((s) => !s.url.includes("sb_secret") && s.init.headers.apikey === "sb_secret_key"));
  await assert.rejects(rest.rpc("drop table x", {}), RestError);
  await assert.rejects(rest.update("raw_clips", {}, { a: 1 }), RestError);
  const gone = restClient("https://abc.supabase.co", "k", async () => new Response(JSON.stringify({ code: "PGRST202", message: "Could not find the function" }), { status: 404 }));
  await assert.rejects(gone.rpc("claim_clip_jobs", {}), (e) => e instanceof RestError && e.notThere);
});

/* ---------- the real ffmpeg ---------- */

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const make = (dir, name, args) => {
  const path = join(dir, name);
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args, path], { stdio: "ignore" });
  assert.equal(r.status, 0, "ffmpeg made " + name);
  return path;
};

test("ffmpeg keeps only the sound, measures it, and cuts long sound in pieces", { skip: !hasFfmpeg && "ffmpeg is not installed here" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "art-reader-test-"));
  try {
    const video = ["-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=5"];
    const tone = make(dir, "tone.mp4", [...video, "-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-shortest", "-c:v", "mpeg4", "-c:a", "aac"]);
    const silent = make(dir, "silent.mp4", [...video, "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-shortest", "-c:v", "mpeg4", "-c:a", "aac"]);
    const mute = make(dir, "mute.mp4", [...video, "-c:v", "mpeg4", "-an"]);
    const { soundVerdict } = await import("../../src/lib/ai/reader/index.ts");

    const a = await extractAudio({ source: tone, authorization: null, chunkSeconds: 3000, knownSeconds: null, tmpDir: dir });
    assert.equal(a.kind, "ok");
    assert.equal(a.pieces.length, 1);
    assert.ok(Math.abs(a.seconds - 5) < 0.5, "about five seconds, got " + a.seconds);
    assert.ok(a.probe.maxDb > -30, "a tone is loud, got " + a.probe.maxDb);
    assert.deepEqual(soundVerdict(a.probe), { sound: true });
    const blob = await a.pieces[0].blob();
    assert.equal(blob.type, "audio/flac");
    assert.equal(new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()).slice(0, 4)), "fLaC", "a FLAC file: sound only, no picture");
    assert.ok(blob.size < 200_000);
    await a.cleanup();
    assert.equal(existsSync(a.pieces[0].path), false, "the sound file is removed");

    const s = await extractAudio({ source: silent, authorization: null, chunkSeconds: 3000, knownSeconds: null, tmpDir: dir });
    assert.equal(s.kind, "ok");
    assert.deepEqual(soundVerdict(s.probe), { sound: false, why: "silent" });
    await s.cleanup();

    const m = await extractAudio({ source: mute, authorization: null, chunkSeconds: 3000, knownSeconds: null, tmpDir: dir });
    assert.equal(m.kind, "no_track");
    await m.cleanup();

    const none = await extractAudio({ source: join(dir, "missing.mp4"), authorization: null, chunkSeconds: 3000, knownSeconds: null, tmpDir: dir });
    assert.equal(none.kind, "fail");
    const nope = await extractAudio({ source: tone, authorization: null, chunkSeconds: 3000, knownSeconds: null, tmpDir: dir, ffmpegPath: "ffmpeg-that-is-not-there" });
    assert.deepEqual(nope, { kind: "fail", detail: "ffmpeg is not installed in the reader." });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ffmpeg is asked for the first sound track only, from Drive with the token in a header", () => {
  const args = ffmpegArgs({ source: "https://www.googleapis.com/drive/v3/files/x?alt=media", authorization: "Bearer t", chunkSeconds: 3000 }, "/tmp/a%03d.flac");
  assert.equal(args[args.indexOf("-headers") + 1], "Authorization: Bearer t\r\n");
  assert.ok(!args[args.indexOf("-i") + 1].includes("Bearer"), "the token is never in the address");
  for (const flag of ["-vn", "-sn", "-dn", "-reconnect"]) assert.ok(args.includes(flag), flag);
  assert.deepEqual([args[args.indexOf("-map") + 1], args[args.indexOf("-ac") + 1], args[args.indexOf("-ar") + 1], args[args.indexOf("-segment_time") + 1]], ["0:a:0", "1", "16000", "3000"]);
  assert.equal(ffmpegArgs({ source: "/local/file.mp4", authorization: null, chunkSeconds: 3000 }, "o").includes("-headers"), false);
});

/* ---------- the fixes after the reviews of Nov 16 2026 ---------- */

const SAID = "This bar lasts longer than three bottles.";

test("filed in Drive but the database did not take it: the Drive work is taken back, so the file never sits in Raw without its Undo", async () => {
  /* another reader (or a person) moved the clip on between the filing and the save */
  let n = 0;
  const moved = setup({
    gemini: [interaction(SAID, TR_USAGE), interaction(matchAnswer(95), H_USAGE)],
    db: { finish: async (id, input) => (++n === 2 ? { ok: false, status: "done", reason: "not_running", batchId: null, batchOpen: null, moveId: null, applied: null } : { ok: true, status: "running", reason: null, batchId: null, batchOpen: null, moveId: null, applied: null }) },
  });
  const end = await readClip(moved.deps, JOB);
  assert.deepEqual([end.end, end.detail], ["lost", "not_running"]);
  assert.deepEqual(moved.drive.filed, [CARD]);
  assert.deepEqual(moved.drive.unfiled, [CARD]);

  /* the card is gone: the database says "refused" */
  const refused = setup({ gemini: [interaction(SAID, TR_USAGE), interaction(matchAnswer(95), H_USAGE)], db: { finish: async () => ({ ok: true, status: "done", reason: null, batchId: "b1", batchOpen: 0, moveId: null, applied: "refused" }) } });
  const r = await readClip(refused.deps, JOB);
  assert.deepEqual([r.end, r.auto], ["done", false]);
  assert.deepEqual(refused.drive.unfiled, [CARD]);

  /* saved, or the same answer sent twice ("already"): Drive is left as it is */
  const saved = setup({ gemini: [interaction(SAID, TR_USAGE), interaction(matchAnswer(95), H_USAGE)], db: { finish: async () => ({ ok: true, status: "done", reason: null, batchId: null, batchOpen: null, moveId: null, applied: null }) } });
  await readClip(saved.deps, JOB);
  assert.deepEqual(saved.drive.unfiled, []);
});

test("something throws half way: the clip goes back for a try and every run still holding money is closed with it", async () => {
  let n = 0;
  const t = setup({
    gemini: [interaction(SAID, TR_USAGE), interaction(matchAnswer(95), H_USAGE)],
    db: {
      finish: async function (id, input) {
        this.calls.push(["finish", input.outcome, input]);
        if (input.outcome === "done" && ++n === 1) throw new Error("Supabase did not answer.");
        return { ok: true, status: "running", reason: null, batchId: null, batchOpen: null, moveId: null, applied: null };
      },
    },
  });
  const end = await readClip(t.deps, JOB);
  assert.equal(end.end, "retry");
  assert.deepEqual(finishes(t.db), ["transcribed", "done", "retry"]);
  const r = lastFinish(t.db);
  assert.deepEqual(r.calls.map((c) => [c.runId, c.tool, c.costUsd]), [["run-2", "match", 0.0042]], "the match call is saved at what it cost; the transcript's run was closed already");

  /* thrown before Gemini answered: the run is closed at $0 */
  const early = setup({ gemini: [], db: { candidates: async () => Promise.reject(new Error("boom")) } });
  const e = await readClip(early.deps, { ...JOB, transcript: SAID });
  assert.equal(e.end, "retry");
  assert.deepEqual(lastFinish(early.db).calls, [], "no money was held yet");
  const late = setup({ gemini: [interaction(SAID, TR_USAGE)], audio: undefined });
  late.deps.gemini.fetch = ((orig) => async (url, init) => {
    if (String(url).endsWith("/v1beta/interactions")) throw new Error("socket hang up");
    return orig(url, init);
  })(late.deps.gemini.fetch);
  const l = await readClip(late.deps, JOB);
  assert.equal(l.end, "retry");
  const closing = lastFinish(late.db).calls;
  assert.equal(closing.length, 1);
  assert.equal(closing[0].runId, "run-1");
  assert.equal(closing[0].ok, false);
});

test("Transcribe answers with nothing although ffmpeg heard sound: tried again (never a No sound video), failed with plain words on the last try", async () => {
  const EMPTY = { total_input_tokens: 1920, total_output_tokens: 0, input_tokens_by_modality: [{ modality: "audio", tokens: 1920 }] };
  const t = setup({ gemini: [interaction("", EMPTY)] });
  const end = await readClip(t.deps, JOB);
  assert.equal(end.end, "retry");
  assert.deepEqual(finishes(t.db), ["retry"]);
  const r = lastFinish(t.db);
  assert.match(r.error, /sent back no text, although the video has sound\. It is tried again/);
  assert.equal(r.calls[0].ok, false, "the call is saved as failed, with what it cost");
  assert.ok(r.calls[0].costUsd > 0);
  assert.equal(t.asked.filter((a) => a.url.endsWith("/v1beta/interactions")).length, 1, "no matching call");

  const last = setup({ gemini: [interaction("   ", EMPTY)] });
  await readClip(last.deps, { ...JOB, attempts: 6 });
  assert.match(lastFinish(last.db).error, /sent back no text six times.*Press Retry/);

  /* a real answer with no words (music, a room) is still a No sound video */
  const music = setup({ gemini: [interaction(" ", TR_USAGE)] });
  assert.equal((await readClip(music.deps, JOB)).end, "no_sound");
});

test("the loop writes no heartbeat in a run that finds nothing, and a queue that stops answering lets the clips in hand finish", async () => {
  const beats = [];
  const quiet = await runLoop({ db: { claim: async () => [], finish: async () => ({}), heartbeat: async (r) => void beats.push(r) }, readOne: async () => assert.fail(), summarise: async () => ({ written: 0, usd: 0, capReached: false }), log: () => {}, concurrency: 4, leaseMinutes: 30, deadline: Date.now() + 60_000, pollMs: 1 });
  assert.equal(quiet.stopped, "empty");
  assert.deepEqual(beats, [], "an empty sweep writes nothing");

  let claims = 0;
  let finished = 0;
  const lines = [];
  const broke = await runLoop({
    db: { claim: async () => (++claims === 1 ? [JOB] : Promise.reject(new Error("Supabase did not answer."))), finish: async () => ({}), heartbeat: async (r) => void beats.push(r) },
    readOne: async (job) => {
      await new Promise((r) => setTimeout(r, 10));
      finished++;
      return { clipId: job.id, end: "done", usd: 0.01, auto: false, batchReady: null, detail: null };
    },
    summarise: async () => assert.fail("no summaries after the queue broke"),
    log: (sev, msg) => void lines.push(msg),
    concurrency: 2,
    leaseMinutes: 30,
    deadline: Date.now() + 60_000,
    pollMs: 1,
  });
  assert.deepEqual([broke.stopped, broke.clips, finished], ["error", 1, 1]);
  assert.deepEqual(beats, [true, false]);
  assert.ok(lines.some((l) => /could not be read/.test(l)));
});
