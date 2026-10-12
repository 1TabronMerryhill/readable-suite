/* Station Gate 2 — local test suite. Plain node asserts, no framework.
   No live data, no network, no GitHub. Run: node station-call.test.js */
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const lib = require("./station-lib");
const pipe = require("./station-call");

const BIZ = {
  id: "biz-1",
  name: "Ellianas",
  slug: "elliannas-donut-shop",
  status: "active",
  phone: "+15734425608",
  address: "1105 Grindstone Pkwy, Columbia, MO",
  hours_text: "Mon-Fri 5am-2pm, Sat-Sun 6am-1pm",
  hours: { open_hour: 5, close_hour: 14 },
  menu_items: [
    { name: "glazed", price_cents: 150, aliases: ["glazed donuts", "glaze"] },
    { name: "chocolate", price_cents: 175, aliases: ["chocolate donuts"] },
    { name: "fritter", price_cents: 250, aliases: ["apple fritter", "fritters"] },
  ],
  packages: [{ id: "p1", name: "Morning Meeting" }],
};
const BIZ_NO_MENU = Object.assign({}, BIZ, { menu_items: [] });

function fixtureDeps(over) {
  over = over || {};
  const written = [];
  const queued = [];
  return {
    deps: {
      getBusinessData: async () => (over.biz === undefined ? BIZ : over.biz),
      resolveBuyer: async (email) => (over.noBuyer ? null : { id: "m1", email }),
      invokeCateringGate: async (input) => {
        if (over.gateFail) return { ok: false, error: "boom" };
        return { ok: true, order: { id: "o1", status: "scheduled" } };
      },
      queueReview: async (p) => {
        queued.push(p);
        return Object.assign({ id: "r1" }, p);
      },
      writeVerification: async (rec) => {
        written.push(rec);
        return Object.assign({ id: "v1" }, rec);
      },
      findVerification: async () => over.dup || null,
      now: () => new Date("2026-10-12T12:00:00Z").getTime(),
    },
    written,
    queued,
  };
}
function ev(text, extra) {
  return Object.assign(
    { business_ref: "elliannas-donut-shop", caller_phone: "+15735550100", text, channel: "sms" },
    extra || {}
  );
}

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

/* ---------- intent ---------- */
test("classify: order with quantity", () => {
  const c = pipe.classifyIntent("I want 3 dozen glazed");
  assert.strictEqual(c.intent, "order");
});
test("classify: question", () => {
  const c = pipe.classifyIntent("what time do you close");
  assert.strictEqual(c.intent, "question");
});
test("classify: greeting", () => {
  assert.strictEqual(pipe.classifyIntent("hi").intent, "greeting");
});
test("classify: unknown", () => {
  assert.strictEqual(pipe.classifyIntent("asdf jkl qwer").intent, "unknown");
});

/* ---------- extraction ---------- */
test("extract: dozen qty + item + pickup + name", () => {
  const e = pipe.extractOrder("I want 3 dozen glazed for 9am, this is Maria", BIZ);
  assert.strictEqual(e.items.length, 1);
  assert.strictEqual(e.items[0].qty, 3);
  assert.strictEqual(e.items[0].unit, "dozen");
  assert.strictEqual(e.items[0].menu_item, "glazed");
  assert.strictEqual(e.pickup.hour, 9);
  assert.strictEqual(e.name_hint, "Maria");
});
test("extract: word numbers and aliases", () => {
  const e = pipe.extractOrder("two dozen chocolate and a dozen fritters", BIZ);
  assert.strictEqual(e.items.length, 2);
  assert.strictEqual(e.items[0].qty, 2);
  assert.strictEqual(e.items[0].menu_item, "chocolate");
  assert.strictEqual(e.items[1].menu_item, "fritter");
});

/* ---------- grounded Q&A ---------- */
test("answer: hours from structured data", () => {
  const a = pipe.answerQuestion("what time do you close?", BIZ);
  assert.ok(a.answer.includes("5am-2pm"), "got: " + a.answer);
});
test("answer: price from menu", () => {
  const a = pipe.answerQuestion("how much is a glazed?", BIZ);
  assert.ok(a.answer.includes("1.50"), "got: " + a.answer);
});
test("answer: unknown item -> unknown (grounding rule)", () => {
  const a = pipe.answerQuestion("do you sell pizza?", BIZ);
  assert.ok(a.unknown, "must not invent an answer");
});
test("answer: hours unknown when unseeded", () => {
  const b = Object.assign({}, BIZ, { hours_text: null });
  assert.ok(pipe.answerQuestion("when do you open?", b).unknown);
});

/* ---------- validation ---------- */
test("validate: good order passes", () => {
  const e = pipe.extractOrder("3 dozen glazed for 9am", BIZ);
  const v = pipe.validateOrder(e, BIZ, Date.now());
  assert.ok(v.valid, JSON.stringify(v.issues));
});
test("validate: insane qty fails", () => {
  const v = pipe.validateOrder(
    { items: [{ phrase: "glazed", qty: 500, unit: "dozen", menu_item: "glazed" }] },
    BIZ, Date.now()
  );
  assert.ok(!v.valid && v.issues.some((i) => i.code === "bad_qty"));
});
test("validate: outside hours fails", () => {
  const e = pipe.extractOrder("2 dozen glazed for 3am", BIZ);
  const v = pipe.validateOrder(e, BIZ, Date.now());
  assert.ok(!v.valid && v.issues.some((i) => i.code === "outside_hours"));
});
test("validate: unknown item suggests alternative", () => {
  const v = pipe.validateOrder(
    { items: [{ phrase: "cronuts", qty: 2, unit: "dozen", menu_item: null }] },
    BIZ, Date.now()
  );
  assert.ok(!v.valid);
  assert.ok(v.suggestions.length > 0, "should suggest a real menu item");
});
test("validate: unseeded menu is soft (never auto-fails)", () => {
  const v = pipe.validateOrder(
    { items: [{ phrase: "glazed", qty: 2, unit: "dozen", menu_item: null }] },
    BIZ_NO_MENU, Date.now()
  );
  assert.ok(v.valid, "soft issues must not fail validation");
  assert.ok(v.issues.some((i) => i.code === "menu_unseeded"));
});

/* ---------- confidence + decision ---------- */
test("decide: high confidence + buyer -> auto_approve", () => {
  const d = pipe.decide({ intent: "order", confidence: 0.9, validation: { valid: true, issues: [] }, buyerResolvable: true });
  assert.strictEqual(d, "auto_approve");
});
test("decide: unseeded menu caps confidence -> human_review", () => {
  const e = pipe.extractOrder("3 dozen glazed", BIZ_NO_MENU);
  const v = pipe.validateOrder(e, BIZ_NO_MENU, Date.now());
  const c = pipe.scoreConfidence({ intent: "order", confidence: 0.9 }, e, v);
  assert.ok(c <= 0.7, "grounding cap, got " + c);
  const d = pipe.decide({ intent: "order", confidence: c, validation: v, buyerResolvable: true });
  assert.strictEqual(d, "human_review");
});
test("decide: invalid -> clarify", () => {
  const d = pipe.decide({ intent: "order", confidence: 0.9, validation: { valid: false, issues: [{ code: "x" }] }, buyerResolvable: true });
  assert.strictEqual(d, "clarify");
});
test("decide: no buyer account -> human_review", () => {
  const d = pipe.decide({ intent: "order", confidence: 0.9, validation: { valid: true, issues: [] }, buyerResolvable: false });
  assert.strictEqual(d, "human_review");
});

/* ---------- full pipeline ---------- */
test("pipeline: auto_approve end to end (mocked deps)", async () => {
  const { deps, written } = fixtureDeps();
  const r = await pipe.runPipeline(ev("I want 3 dozen glazed for 9am", { buyer_email: "a@b.com" }), deps);
  assert.strictEqual(r.decision, "auto_approve");
  assert.ok(r.reply.includes("3 dozen glazed"), "truthful items, got: " + r.reply);
  assert.ok(r.reply.includes("Pay at pickup"), "payment truth, got: " + r.reply);
  assert.strictEqual(r.order.id, "o1");
  assert.ok(written.some((w) => w.event_type === "order_auto_approved"));
});
test("pipeline: no buyer -> human_review with pending truth", async () => {
  const { deps, queued } = fixtureDeps({ noBuyer: true });
  const r = await pipe.runPipeline(ev("3 dozen glazed for 9am"), deps);
  assert.strictEqual(r.decision, "human_review");
  assert.ok(r.reply.includes("will confirm by text"), "got: " + r.reply);
  assert.strictEqual(queued.length, 1);
  assert.strictEqual(queued[0].status, "pending");
});
test("pipeline: gate failure falls back to review, never silence", async () => {
  const { deps } = fixtureDeps({ gateFail: true });
  const r = await pipe.runPipeline(ev("3 dozen glazed for 9am", { buyer_email: "a@b.com" }), deps);
  assert.strictEqual(r.decision, "human_review");
  assert.ok(r.reply.length > 10);
});
test("pipeline: invalid item -> clarify with real alternative", async () => {
  const { deps } = fixtureDeps();
  const r = await pipe.runPipeline(ev("2 dozen cronuts for 9am"), deps);
  assert.strictEqual(r.decision, "clarify");
  assert.ok(/glazed|chocolate|fritter/.test(r.reply), "got: " + r.reply);
});
test("pipeline: question answered from data", async () => {
  const { deps } = fixtureDeps();
  const r = await pipe.runPipeline(ev("what time do you close?"), deps);
  assert.strictEqual(r.decision, "answered");
  assert.ok(r.reply.includes("5am-2pm"));
});
test("pipeline: unanswerable -> escalate, never invent", async () => {
  const { deps } = fixtureDeps();
  const r = await pipe.runPipeline(ev("do you cater weddings in Kansas City?"), deps);
  assert.strictEqual(r.decision, "escalate");
  assert.ok(r.reply.includes("I'll have someone"), "got: " + r.reply);
});
test("pipeline: idempotency returns original run", async () => {
  const first = fixtureDeps();
  const e = ev("3 dozen glazed for 9am", { buyer_email: "a@b.com", idempotency_key: "sms:ABC" });
  await pipe.runPipeline(e, first.deps);
  const hash = first.written[0].inputs_hash;
  const second = fixtureDeps({ dup: { inputs_hash: hash, event_type: "order_auto_approved" } });
  const r = await pipe.runPipeline(e, second.deps);
  assert.ok(r.duplicate, "expected duplicate flag");
});
test("pipeline: inactive business rejected", async () => {
  const { deps } = fixtureDeps({ biz: Object.assign({}, BIZ, { status: "suspended" }) });
  const r = await pipe.runPipeline(ev("3 dozen glazed"), deps);
  assert.strictEqual(r.decision, "rejected");
});

/* ---------- Twilio signature ---------- */
function twilioSig(token, url, params) {
  const names = Object.keys(params).sort();
  let data = url;
  for (const n of names) data += n + params[n];
  return crypto.createHmac("sha1", token).update(data, "utf8").digest("base64");
}
test("twilio: valid signature verifies", () => {
  const token = "testtoken123";
  const url = "https://example.com/api/station/sms";
  const params = { From: "+15735550100", To: "+15735550200", Body: "hi", MessageSid: "SM1" };
  const sig = twilioSig(token, url, params);
  assert.ok(lib.verifyTwilioSignature(token, url, params, sig));
});
test("twilio: tampered body fails", () => {
  const token = "testtoken123";
  const url = "https://example.com/api/station/sms";
  const params = { From: "+15735550100", Body: "hi" };
  const sig = twilioSig(token, url, params);
  assert.ok(!lib.verifyTwilioSignature(token, url, Object.assign({}, params, { Body: "bye" }), sig));
});
test("twilio: wrong token fails", () => {
  const url = "https://example.com/api/station/sms";
  const params = { From: "+1" };
  const sig = twilioSig("right", url, params);
  assert.ok(!lib.verifyTwilioSignature("wrong", url, params, sig));
});

/* ---------- TwiML ---------- */
test("twiml: sms reply is valid", () => {
  const x = lib.smsReply("Hello & goodbye");
  assert.ok(x.includes("<Message>Hello &amp; goodbye</Message>"));
});
test("twiml: voice stub has Say + Sms + Hangup", () => {
  const x = lib.voiceGreetingThenSms({ sayText: "hi", smsFrom: "+11", smsTo: "+12", smsText: "yo" });
  assert.ok(x.includes("<Say") && x.includes("<Sms") && x.includes("<Hangup"));
});

/* ---------- phone normalization ---------- */
test("phone: normalize US formats", () => {
  assert.strictEqual(lib.normalizePhone("(573) 555-0100"), "+15735550100");
  assert.strictEqual(lib.normalizePhone("+15735550100"), "+15735550100");
  assert.strictEqual(lib.normalizePhone("notaphone"), null);
});

/* ---------- artifacts ---------- */
test("manifest: valid JSON with 3 capabilities", () => {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "../../.well-known/agent.json"), "utf8"));
  const names = d.capabilities.map((c) => c.name || c.endpoint.path);
  assert.ok(names.includes("answer_call"), names.join(","));
  assert.ok(names.includes("complete_text_order"), names.join(","));
  assert.ok(names.includes("order_catering"), names.join(","));
});
test("netlify.toml: station redirects present", () => {
  const t = fs.readFileSync(path.join(__dirname, "../../netlify.toml"), "utf8");
  assert.ok(t.includes('from = "/api/station/sms"'));
  assert.ok(t.includes('from = "/api/station/voice"'));
  assert.ok(t.includes("sms-inbound") && t.includes("voice-webhook"));
});
test("migration: review table + verification extension", () => {
  const s = fs.readFileSync(path.join(__dirname, "../../supabase/migration-station-v1.sql"), "utf8");
  assert.ok(s.includes("create table if not exists public.dm_station_reviews"));
  assert.ok(s.includes("alter table public.dm_agent_verifications alter column order_id drop not null"));
  assert.ok(s.includes("add column if not exists channel"));
  assert.ok(s.includes("add column if not exists event_type"));
  assert.ok(s.includes("review_reason"));
});

(async () => {
  let pass = 0;
  const fails = [];
  for (const [name, fn] of tests) {
    try {
      await fn();
      pass++;
    } catch (e) {
      fails.push([name, e]);
    }
  }
  console.log(`${pass}/${tests.length} passed`);
  for (const [name, e] of fails) console.log("FAIL:", name, "-", e.message.split("\n")[0]);
  process.exit(fails.length ? 1 : 0);
})();
