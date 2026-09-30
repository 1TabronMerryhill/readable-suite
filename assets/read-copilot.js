/* Read/co-pilot — Readiness Assessment engine.
   Rubric v1.0. Deterministic: the same answers always produce the same score.
   Derived strictly from Course 4 objectives 1-3 (Capstone and Human Review,
   Practical AI Readiness program). No Violet materials are used anywhere here.
   Single versioned source: bump READ_COPILOT_RUBRIC_VERSION with any change. */
(function () {
  "use strict";

  var READ_COPILOT_RUBRIC_VERSION = "1.0";
  window.READ_COPILOT_RUBRIC_VERSION = READ_COPILOT_RUBRIC_VERSION;

  /* ---------------- Rubric ---------------- */

  var DIMENSIONS = [
    { id: "D1", name: "Problem boundedness", objective: "Objective 1",
      solid: "One workflow with a clear start and end.",
      findings: {
        2: "The problem is bounded tightly enough to assess.",
        1: "The scope is wide. Narrow to one workflow before judging AI fit.",
        0: "The problem is unbounded. Nothing can be assessed until it is narrowed."
      } },
    { id: "D2", name: "Measurable outcome", objective: "Objective 1",
      solid: "The intended outcome is stated with a number or a date.",
      findings: {
        2: "Success is measurable — the 90-day check will mean something.",
        1: "The outcome is described but not measurable. Attach a number or date.",
        0: "No defined outcome. Decide what 'worked' means before starting."
      } },
    { id: "D3", name: "AI-task fit", objective: "Objective 1",
      solid: "AI proposes; a human disposes. AI's role matches what AI does well.",
      findings: {
        2: "AI's role fits its strengths, with a human deciding.",
        1: "AI acts with only spot-checks. Tighten the bounds or add review.",
        0: "AI decides or publishes directly. This is the highest-risk pattern in the rubric."
      } },
    { id: "D4", name: "Alternative weighed", objective: "Objective 1",
      solid: "A non-AI (or simpler) approach was weighed and rejected for a reason.",
      findings: {
        2: "A simpler path was considered and ruled out deliberately.",
        1: "The alternative got a glance. Write down why it loses.",
        0: "No alternative was weighed. AI may be a solution in search of a problem."
      } },
    { id: "D5", name: "Inputs & data boundaries", objective: "Objective 2",
      solid: "Authorized inputs are defined; sensitive data is excluded or governed.",
      findings: {
        2: "Inputs are bounded and sensitive data is handled.",
        1: "Inputs are loosely defined. List exactly what may enter the AI.",
        0: "Sensitive or undefined inputs. Fix this before anything else — it is a liability."
      } },
    { id: "D6", name: "Human authority", objective: "Objective 2",
      solid: "A named human holds final decision authority.",
      findings: {
        2: "Accountability sits with one named human.",
        1: "A team owns it with no single owner. Name the decider.",
        0: "No human holds the decision. Assign final authority to a person."
      } },
    { id: "D7", name: "Acceptance & verification", objective: "Objectives 2 & 3",
      solid: "Written, checkable acceptance criteria; outputs verified against evidence.",
      findings: {
        2: "Outputs are judged against written criteria and source evidence.",
        1: "Verification is informal. Write the criteria down and check against evidence.",
        0: "Outputs go unverified. This is where confident errors ship."
      } },
    { id: "D8", name: "Failure handling & output discipline", objective: "Objectives 2 & 3",
      solid: "A documented exception path exists; outputs are accepted, revised, rejected, or escalated — never auto-accepted.",
      findings: {
        2: "Failure has a path and outputs face a real decision.",
        1: "Failure handling is informal. Document the exception path and the escalation.",
        0: "No failure plan and outputs are auto-accepted. The workflow trusts the AI completely."
      } }
  ];

  /* ---------------- Interview ---------------- */

  var SECTIONS = ["You", "The problem", "The workflow", "Decisions & verification", "When it fails"];

  var QUESTIONS = [
    { id: "contact_name", section: 0, kind: "text", required: true, label: "Your name" },
    { id: "contact_email", section: 0, kind: "email", required: true, label: "Work email", hint: "Your report and receipt go here." },
    { id: "business_name", section: 0, kind: "text", required: true, label: "Organization" },
    { id: "contact_role", section: 0, kind: "text", required: false, label: "Your role", hint: "Optional." },

    { id: "q_problem", section: 1, kind: "textarea", required: true, context: true,
      label: "In one or two sentences, what problem are you trying to solve?",
      hint: "Be specific — vague problems get vague verdicts." },
    { id: "q_bounded", section: 1, kind: "choice", dimension: "D1", required: true,
      label: "How bounded is the problem?",
      options: [
        { t: "One workflow with a clear start and end", s: 2 },
        { t: "A department-level process with several workflows", s: 1 },
        { t: "Organization-wide, or we're not sure yet", s: 0 }
      ] },
    { id: "q_outcome", section: 1, kind: "choice", dimension: "D2", required: true,
      label: "Is the intended outcome measurable?",
      options: [
        { t: "Yes — there's a number, a date, or both", s: 2 },
        { t: "Described, but not measurable", s: 1 },
        { t: "Not defined yet", s: 0 }
      ] },

    { id: "q_steps", section: 2, kind: "textarea", required: true, context: true,
      label: "Describe the workflow in 3–6 steps.",
      hint: "Number them. This becomes your structured evidence." },
    { id: "q_ai_touch", section: 2, kind: "choice", dimension: "D3", required: true,
      label: "Where does AI touch the workflow?",
      options: [
        { t: "AI drafts or proposes; a human reviews and decides", s: 2 },
        { t: "AI acts within bounded rules; a human spot-checks", s: 1 },
        { t: "AI decides or sends output directly — or we're not sure", s: 0 }
      ] },
    { id: "q_alternative", section: 2, kind: "choice", dimension: "D4", required: true,
      label: "Have you weighed a non-AI alternative?",
      options: [
        { t: "Yes — and we know why AI still wins", s: 2 },
        { t: "Briefly considered", s: 1 },
        { t: "No", s: 0 }
      ] },

    { id: "q_inputs", section: 3, kind: "choice", dimension: "D5", required: true,
      label: "What data goes into the AI?",
      options: [
        { t: "A defined list — no customer PII or confidential data ungoverned", s: 2 },
        { t: "Mixed, loosely defined", s: 1 },
        { t: "Includes customer PII / confidential data, or undefined", s: 0 }
      ] },
    { id: "q_authority", section: 3, kind: "choice", dimension: "D6", required: true,
      label: "Who is accountable for this workflow's outputs?",
      options: [
        { t: "A named human with final decision authority", s: 2 },
        { t: "A team — no single owner", s: 1 },
        { t: "No one, or the AI itself", s: 0 }
      ] },
    { id: "q_criteria", section: 3, kind: "choice", dimension: "D7", required: true,
      label: "Are there written acceptance criteria?",
      options: [
        { t: "Yes — checkable", s: 2 },
        { t: "Informal — “looks right”", s: 1 },
        { t: "None", s: 0 }
      ] },
    { id: "q_verify", section: 3, kind: "choice", dimension: "D7", required: true,
      label: "How are AI outputs verified before use?",
      options: [
        { t: "Checked against source evidence, every time", s: 2 },
        { t: "Spot-checked", s: 1 },
        { t: "Used as-is", s: 0 }
      ] },

    { id: "q_failure", section: 4, kind: "choice", dimension: "D8", required: true,
      label: "When the AI is wrong, what happens?",
      options: [
        { t: "Documented exception path — escalation to a human", s: 2 },
        { t: "Someone notices eventually", s: 1 },
        { t: "Nothing — or we don't know", s: 0 }
      ] },
    { id: "q_output_decision", section: 4, kind: "choice", dimension: "D8", required: true,
      label: "What does the human do with an AI output?",
      options: [
        { t: "Accept, revise, reject, or escalate — per criteria", s: 2 },
        { t: "Usually accept, sometimes edit", s: 1 },
        { t: "Accept as-is", s: 0 }
      ] },
    { id: "q_measure", section: 4, kind: "textarea", required: true, context: true,
      label: "How will you know in 90 days whether this worked?",
      hint: "Name the metric and the review date. This becomes your measurement plan." }
  ];

  var DIM_QUESTIONS = {};
  QUESTIONS.forEach(function (q) {
    if (q.dimension) (DIM_QUESTIONS[q.dimension] = DIM_QUESTIONS[q.dimension] || []).push(q.id);
  });

  /* ---------------- Scoring (deterministic) ---------------- */

  function scoreAssessment(answers) {
    // answers: { questionId: score } for choice questions, { questionId: text/optionText }
    var raw = {};
    QUESTIONS.forEach(function (q) { if (q.kind === "choice" && answers[q.id] != null) raw[q.id] = answers[q.id]; });

    var dims = {};
    DIMENSIONS.forEach(function (d) {
      var qs = DIM_QUESTIONS[d.id] || [];
      var sum = 0, n = 0;
      qs.forEach(function (qid) { if (raw[qid] != null) { sum += raw[qid]; n++; } });
      dims[d.id] = n ? Math.round(sum / n) : 0;
    });

    var total = DIMENSIONS.reduce(function (t, d) { return t + dims[d.id]; }, 0);
    var verdict = total >= 13 ? "ready" : (total >= 8 ? "safeguards" : "not-ready");
    return { dims: dims, total: total, verdict: verdict };
  }

  var VERDICTS = {
    "ready": {
      title: "READY",
      headline: "Go build.",
      body: "This workflow is sound. AI fits the task, a human holds authority, and outputs are checked against evidence. The structured spec below is yours — hand it to whoever builds it."
    },
    "safeguards": {
      title: "READY WITH SAFEGUARDS",
      headline: "Fix the gaps first.",
      body: "This workflow can work, but the gaps below need closing before AI touches anything consequential. Each gap names its closing action."
    },
    "not-ready": {
      title: "NOT READY",
      headline: "Don't automate the confusion.",
      body: "This workflow has structural gaps. Putting AI on it now would scale the problems, not solve them. The gap list below is your fix list."
    }
  };

  function prescribe(result) {
    var d = result.dims, v = result.verdict;
    if (v === "not-ready") return "sprint";
    if (v === "ready") return "academy";
    var design = d.D1 + d.D5 + d.D6 + d.D7;
    if (design < 5) return "sprint";
    if (d.D8 < 1) return "academy";
    return "sprint";
  }

  var INTERVENTIONS = {
    "sprint": {
      name: "Business Visibility Sprint", price: "$2,500 one-time", url: "/business-systems/",
      blurb: "A 10-business-day engagement that extracts this workflow, designs it properly, and hands you a buildable spec. Your gap list above doubles as the Sprint brief."
    },
    "academy": {
      name: "Readable Academy", price: "from $1,000", url: "/academy/",
      blurb: "Train your team in the exact muscle this assessment measured: evaluating AI outputs against evidence and keeping human judgment in charge."
    }
  };

  function optionText(qid, score) {
    var q = QUESTIONS.filter(function (x) { return x.id === qid; })[0];
    if (!q || !q.options) return "";
    var o = q.options.filter(function (op) { return op.s === score; })[0];
    return o ? o.t : "";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function reportId() {
    var d = new Date();
    var ymd = d.getFullYear().toString() + ("0" + (d.getMonth() + 1)).slice(-2) + ("0" + d.getDate()).slice(-2);
    return "RA-" + ymd + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
  }

  /* ---------------- Interview UI ---------------- */

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function startInterview(mountId, onDone) {
    var mount = document.getElementById(mountId);
    if (!mount) return;
    var answers = {};   // qid -> score (choice) or text
    var answerText = {}; // qid -> selected option text (choice)
    var idx = 0;

    function progress() {
      return Math.round((idx / QUESTIONS.length) * 100);
    }

    function render() {
      mount.innerHTML = "";
      var q = QUESTIONS[idx];

      var wrap = el("div", "rc-q");
      wrap.appendChild(el("p", "rc-kicker", "Read&thinsp;/&thinsp;co-pilot · " + esc(SECTIONS[q.section]) + " · " + (idx + 1) + " of " + QUESTIONS.length));

      var bar = el("div", "rc-progress"); bar.appendChild(el("i", "", ""));
      bar.firstChild.style.width = progress() + "%";
      wrap.appendChild(bar);

      wrap.appendChild(el("h2", "rc-prompt", esc(q.label)));
      if (q.hint) wrap.appendChild(el("p", "rc-hint", esc(q.hint)));

      var inputArea = el("div", "rc-input");
      if (q.kind === "choice") {
        q.options.forEach(function (op) {
          var b = el("button", "rc-opt" + (answers[q.id] === op.s ? " sel" : ""), esc(op.t));
          b.type = "button";
          b.onclick = function () {
            answers[q.id] = op.s;
            answerText[q.id] = op.t;
            render();
          };
          inputArea.appendChild(b);
        });
      } else {
        var ta = document.createElement(q.kind === "textarea" ? "textarea" : "input");
        if (q.kind !== "textarea") ta.type = q.kind === "email" ? "email" : "text";
        ta.className = "rc-text";
        ta.value = answers[q.id] || "";
        ta.setAttribute("aria-label", q.label);
        if (q.kind === "textarea") ta.rows = 4;
        ta.oninput = function () { answers[q.id] = ta.value; };
        inputArea.appendChild(ta);
      }
      wrap.appendChild(inputArea);

      var nav = el("div", "rc-nav");
      if (idx > 0) {
        var back = el("button", "rc-back", "← Back"); back.type = "button";
        back.onclick = function () { idx--; render(); };
        nav.appendChild(back);
      }
      var next = el("button", "rc-next", idx === QUESTIONS.length - 1 ? "See my report →" : "Continue →");
      next.type = "button";
      next.onclick = function () {
        var v = answers[q.id];
        if (q.required) {
          if (q.kind === "choice" && v == null) { inputArea.classList.add("rc-shake"); setTimeout(function(){inputArea.classList.remove("rc-shake");}, 400); return; }
          if (q.kind !== "choice" && !String(v || "").trim()) { inputArea.classList.add("rc-shake"); setTimeout(function(){inputArea.classList.remove("rc-shake");}, 400); return; }
          if (q.kind === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v).trim())) { inputArea.classList.add("rc-shake"); setTimeout(function(){inputArea.classList.remove("rc-shake");}, 400); return; }
        }
        if (idx < QUESTIONS.length - 1) { idx++; render(); window.scrollTo(0, 0); }
        else onDone(answers, answerText);
      };
      nav.appendChild(next);
      wrap.appendChild(nav);
      mount.appendChild(wrap);
      var focusable = wrap.querySelector(".rc-text");
      if (focusable) focusable.focus();
    }

    render();
  }

  /* ---------------- Conversational Read (v1.1) ---------------- */
  /* Open conversation via /.netlify/functions/read-chat. The LLM structures
     evidence; the buyer confirms it; the deterministic scorer judges it.
     Falls back to startInterview when the chat backend isn't configured. */

  var CHAT_ENDPOINT = "/.netlify/functions/read-chat";

  function probeChat(cb) {
    fetch(CHAT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "probe" })
    }).then(function (r) { return r.json(); })
      .then(function (j) { cb(!!(j && j.ok && j.configured)); })
      .catch(function () { cb(false); });
  }

  function wireMic(btn, input) {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { btn.hidden = true; return; }
    var rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = false;
    var live = false;
    btn.onclick = function () {
      if (live) { try { rec.stop(); } catch (e) {} return; }
      try { rec.start(); } catch (e) {}
    };
    rec.onstart = function () { live = true; btn.classList.add("live"); };
    rec.onend = function () { live = false; btn.classList.remove("live"); };
    rec.onerror = function () { live = false; btn.classList.remove("live"); };
    rec.onresult = function (e) {
      var t = e.results[e.results.length - 1][0].transcript;
      input.value = (input.value ? input.value + " " : "") + t;
      input.focus();
    };
  }

  function startConversation(mountId, onDone, opts) {
    var mount = document.getElementById(mountId);
    if (!mount) return;
    opts = opts || {};
    var messages = [];
    var busy = false;
    var reviewShown = false;
    var REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    mount.innerHTML = "";
    var wrap = el("div", "rc-chat");
    var log = el("div", "rc-log");
    log.setAttribute("aria-live", "polite");
    var reviewRow = el("div", "rc-reviewrow");
    var reviewBtn = el("button", "rc-review", "Review what I heard &rarr;");
    reviewBtn.type = "button";
    reviewBtn.hidden = true;
    reviewBtn.onclick = requestExtract;
    reviewRow.appendChild(reviewBtn);
    var formRow = el("div", "rc-inputrow");
    var micBtn = el("button", "rc-mic", "&#127908;");
    micBtn.type = "button";
    micBtn.title = "Dictate";
    micBtn.setAttribute("aria-label", "Dictate your answer");
    var input = document.createElement("input");
    input.className = "rc-chatinput";
    input.type = "text";
    input.placeholder = "Talk in your own words…";
    input.setAttribute("aria-label", "Your message to Read");
    input.setAttribute("autocomplete", "off");
    var sendBtn = el("button", "rc-send", "Send");
    sendBtn.type = "button";
    formRow.appendChild(micBtn);
    formRow.appendChild(input);
    formRow.appendChild(sendBtn);
    wrap.appendChild(log);
    wrap.appendChild(reviewRow);
    wrap.appendChild(formRow);
    wrap.appendChild(el("p", "rc-note", "This conversation isn't stored or used to train anything. Only the answers you confirm and your report are kept."));
    mount.appendChild(wrap);

    wireMic(micBtn, input);

    function scrollDown() { log.scrollTop = log.scrollHeight; }
    function bubble(role, html, isError) {
      var d = el("div", "rc-msg " + role + (isError ? " error" : ""), html);
      log.appendChild(d);
      scrollDown();
      return d;
    }
    function streamInto(d, safeHtml) {
      var toks = safeHtml.split(/(\s+)/);
      var i = 0, out = "";
      var timer = setInterval(function () {
        if (i >= toks.length) { clearInterval(timer); d.innerHTML = out; scrollDown(); return; }
        out += toks[i++];
        d.innerHTML = out + '<span class="rc-stream-caret"></span>';
        if (i % 4 === 0) scrollDown();
      }, 26);
    }

    bubble("read", "Hey — I'm Read. Forget the form: just tell me about the workflow in your own words. What's the problem you're trying to solve?");

    function showReview() {
      if (reviewShown) return;
      reviewShown = true;
      reviewBtn.hidden = false;
      scrollDown();
    }

    function userTurns() {
      return messages.filter(function (m) { return m.role === "user"; }).length;
    }

    function send() {
      var text = input.value.trim();
      if (!text || busy) return;
      input.value = "";
      messages.push({ role: "user", content: text });
      bubble("user", esc(text));
      if (userTurns() >= 6) showReview();
      busy = true;
      var t = bubble("read", '<span class="rc-dots"><i></i><i></i><i></i></span>');
      fetch(CHAT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "chat", messages: messages })
      }).then(function (r) { return r.json(); }).then(function (data) {
        busy = false;
        if (t.parentNode) t.parentNode.removeChild(t);
        if (data && data.ok === false && data.reason === "not_configured") {
          mount.innerHTML = "";
          mount.appendChild(el("p", "rc-note", "Read's conversation mode isn't wired up yet — the structured interview below gets you the same report."));
          var sub = el("div", "");
          sub.id = "rc-fallback";
          mount.appendChild(sub);
          startInterview("rc-fallback", onDone);
          return;
        }
        if (!data || !data.ok || !data.text) throw new Error("bad response");
        var reply = String(data.text);
        var ready = /\[\[READY\]\]/.test(reply);
        reply = reply.replace(/\[\[READY\]\]/g, "").trim();
        messages.push({ role: "assistant", content: reply });
        var rb = bubble("read", "");
        var safe = esc(reply).replace(/\n/g, "<br>");
        if (REDUCED || !opts.stream) { rb.innerHTML = safe; scrollDown(); }
        else streamInto(rb, safe);
        if (ready) showReview();
      }).catch(function () {
        busy = false;
        if (t.parentNode) t.parentNode.removeChild(t);
        bubble("read", "I lost the thread there — say that again?", true);
      });
    }

    sendBtn.onclick = send;
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") send(); });
    input.focus();
    if (opts.initialMessage) {
      input.value = opts.initialMessage;
      setTimeout(send, 400);
    }

    function requestExtract() {
      if (busy) return;
      busy = true;
      reviewBtn.disabled = true;
      reviewBtn.textContent = "Pulling together what I heard…";
      fetch(CHAT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "extract", messages: messages })
      }).then(function (r) { return r.json(); }).then(function (data) {
        busy = false;
        if (!data || !data.ok || !data.packet) throw new Error("bad extract");
        renderConfirm(mount, data.packet, onDone);
      }).catch(function () {
        busy = false;
        reviewBtn.disabled = false;
        reviewBtn.innerHTML = "Review what I heard &rarr;";
        bubble("read", "I couldn't pull that together — give the button another try in a moment?", true);
      });
    }
  }

  /* Buyer confirms the structured evidence before the rubric judges it. */
  function renderConfirm(mount, packet, onConfirm) {
    mount.innerHTML = "";
    packet = packet || {};
    var contact = packet.contact || {};
    var context = packet.context || {};
    var heard = {};
    (packet.dimensions || []).forEach(function (d) { if (d && d.id) heard[d.id] = d; });

    var wrap = el("div", "rc-confirm");
    wrap.appendChild(el("p", "rc-kicker", "Read&thinsp;/&thinsp;co-pilot · confirm the evidence"));
    wrap.appendChild(el("h2", "rc-prompt", "Here's what I heard."));
    wrap.appendChild(el("p", "rc-hint", "Check it. Change any score. Nothing is judged until you confirm."));

    function labeledInput(label, value, required, type) {
      var f = el("div", "rc-field");
      f.appendChild(el("label", "", esc(label) + (required ? " *" : "")));
      var inp = document.createElement("input");
      inp.type = type || "text";
      inp.className = "rc-text";
      inp.value = value || "";
      f.appendChild(inp);
      f._input = inp;
      f._required = !!required;
      return f;
    }

    var grid = el("div", "rc-confirm-grid");
    var fName = labeledInput("Your name", contact.name, true);
    var fOrg = labeledInput("Organization", contact.org, true);
    var fRole = labeledInput("Your role", contact.role, false);
    var fEmail = labeledInput("Work email", "", true, "email");
    fEmail.querySelector("input").placeholder = "Your report goes here.";
    grid.appendChild(fName); grid.appendChild(fOrg);
    grid.appendChild(fRole); grid.appendChild(fEmail);
    wrap.appendChild(grid);

    function labeledArea(label, value) {
      var f = el("div", "rc-field");
      f.appendChild(el("label", "", esc(label)));
      var ta = document.createElement("textarea");
      ta.className = "rc-text";
      ta.rows = 3;
      ta.value = value || "";
      f.appendChild(ta);
      f._input = ta;
      return f;
    }
    var aProblem = labeledArea("The problem, in your words", context.problem);
    var aSteps = labeledArea("The workflow steps", context.steps);
    var aMeasure = labeledArea("How you'll know in 90 days it worked", context.measure);
    wrap.appendChild(aProblem); wrap.appendChild(aSteps); wrap.appendChild(aMeasure);

    var scores = {};
    DIMENSIONS.forEach(function (d, di) {
      var h = heard[d.id] || {};
      var s = (h.score === 0 || h.score === 1 || h.score === 2) ? h.score : 1;
      scores[d.id] = s;
      var card = el("div", "rc-dimedit");
      card.appendChild(el("div", "rc-dim-head", "<strong>" + esc(d.id + " · " + d.name) + "</strong>"));
      card.appendChild(el("p", "rc-note", "Solid looks like: " + esc(d.solid)));
      var pick = el("div", "rc-scorepick");
      pick.setAttribute("role", "group");
      pick.setAttribute("aria-label", d.name + " score");
      [0, 1, 2].forEach(function (v) {
        var b = el("button", v === s ? "sel" : "", String(v));
        b.type = "button";
        b.setAttribute("aria-pressed", v === s ? "true" : "false");
        b.onclick = function () {
          scores[d.id] = v;
          var kids = pick.querySelectorAll("button");
          for (var i = 0; i < kids.length; i++) {
            kids[i].className = kids[i].textContent === String(v) ? "sel" : "";
            kids[i].setAttribute("aria-pressed", kids[i].textContent === String(v) ? "true" : "false");
          }
        };
        pick.appendChild(b);
      });
      card.appendChild(pick);
      var quote = String(h.quote || "").trim();
      if (quote) card.appendChild(el("p", "rc-evidence", "You said: “" + esc(quote) + "”"));
      card.classList.add("rc-rise");
      card.style.animationDelay = (di * 70) + "ms";
      wrap.appendChild(card);
    });

    var err = el("p", "rc-note", "");
    err.style.color = "#8c2f2f";
    wrap.appendChild(err);

    var nav = el("div", "rc-nav");
    var confirmBtn = el("button", "rc-next", "Confirm & see my report →");
    confirmBtn.type = "button";
    confirmBtn.onclick = function () {
      var required = [fName, fOrg, fEmail];
      for (var i = 0; i < required.length; i++) {
        var inp = required[i]._input;
        if (!inp.value.trim()) {
          err.textContent = "Name, organization, and work email are required.";
          inp.focus();
          return;
        }
      }
      var em = fEmail._input.value.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) {
        err.textContent = "That email doesn't look right.";
        fEmail._input.focus();
        return;
      }
      err.textContent = "";
      var answers = {
        contact_name: fName._input.value.trim(),
        contact_email: em,
        business_name: fOrg._input.value.trim(),
        contact_role: fRole._input.value.trim(),
        q_problem: aProblem._input.value.trim(),
        q_steps: aSteps._input.value.trim(),
        q_measure: aMeasure._input.value.trim()
      };
      var answerText = {};
      DIMENSIONS.forEach(function (d) {
        var s = scores[d.id];
        var q = String((heard[d.id] || {}).quote || "").trim();
        (DIM_QUESTIONS[d.id] || []).forEach(function (qid) {
          answers[qid] = s;
          answerText[qid] = q;
        });
      });
      onConfirm(answers, answerText, { mode: "conversational" });
    };
    nav.appendChild(confirmBtn);
    wrap.appendChild(nav);
    mount.appendChild(wrap);
    window.scrollTo(0, 0);
  }

  /* ---------------- Report ---------------- */

  function lowestDims(result, n) {
    return DIMENSIONS.slice().sort(function (a, b) { return result.dims[a.id] - result.dims[b.id]; }).slice(0, n || 3);
  }

  function renderReport(mountId, answers, answerText, meta) {
    var mount = document.getElementById(mountId);
    if (!mount) return null;
    var result = scoreAssessment(answers);
    var v = VERDICTS[result.verdict];
    var interventionKey = prescribe(result);
    var intervention = INTERVENTIONS[interventionKey];
    var rid = reportId();
    var date = new Date().toISOString().slice(0, 10);

    var dimRows = DIMENSIONS.map(function (d) {
      var s = result.dims[d.id];
      var qids = DIM_QUESTIONS[d.id] || [];
      var cited = qids.map(function (qid) { return answerText[qid]; }).filter(Boolean).join(" · ");
      var bars = [0, 1, 2].map(function (i) {
        return '<i class="' + (i < s ? "on" : "") + '"></i>';
      }).join("");
      return '<div class="rc-dim">' +
        '<div class="rc-dim-head"><strong>' + esc(d.id + " · " + d.name) + '</strong>' +
        '<span class="rc-score"><span class="rc-pips">' + bars + '</span>' + s + "/2</span></div>" +
        '<p class="rc-evidence">You said: “' + esc(cited) + '”</p>' +
        '<p>' + esc(d.findings[s]) + '</p></div>';
    }).join("");

    var gaps = lowestDims(result).map(function (d) {
      return "<li><strong>" + esc(d.name) + " (" + result.dims[d.id] + "/2):</strong> " + esc(d.findings[result.dims[d.id]]) + "</li>";
    }).join("");

    var ctaUrl = interventionKey === "sprint" ? "/business-systems/" : "/academy/";
    var ctaLabel = interventionKey === "sprint" ? "Book the Sprint — $2,500" : "See the Academy";

    mount.innerHTML =
      '<div class="rc-report">' +
      '<p class="rc-kicker">Measured report · ' + esc(rid) + ' · ' + esc(date) + ' · Rubric v' + READ_COPILOT_RUBRIC_VERSION + '</p>' +
      '<div class="rc-verdict ' + result.verdict + '"><p class="rc-kicker">' + v.title + ' · ' + result.total + '/16</p>' +
      '<h2>' + esc(v.headline) + '</h2><p>' + esc(v.body) + '</p></div>' +

      '<h3>How each dimension scored</h3>' +
      '<p class="rc-note">Every score cites your own answer as evidence. Same answers, same score — the rubric is deterministic.</p>' +
      '<div class="rc-dims">' + dimRows + '</div>' +

      '<h3>Recommended intervention</h3>' +
      '<div class="rc-card"><p class="rc-kicker">' + esc(intervention.name) + ' · ' + esc(intervention.price) + '</p>' +
      '<p>' + esc(intervention.blurb) + '</p>' +
      '<p><a class="btn" href="' + ctaUrl + '">' + esc(ctaLabel) + '</a></p></div>' +

      '<h3>Your 90-day measure</h3>' +
      '<div class="rc-card"><p>You said: “' + esc(answers.q_measure || "") + '”</p>' +
      '<p>Re-measure on that date against your three weakest dimensions:</p><ol>' + gaps + '</ol>' +
      '<p class="rc-note">A re-assessment against this same rubric is the honest way to know the work held.</p></div>' +

      '<h3>Your structured evidence</h3>' +
      '<div class="rc-card"><p><strong>Problem:</strong> ' + esc(answers.q_problem || "") + '</p>' +
      '<p><strong>Workflow:</strong><br>' + esc(answers.q_steps || "").replace(/\n/g, "<br>") + '</p></div>' +

      '<div class="rc-method">' +
      '<p><strong>Method.</strong> Machine-scored from Tabron Merryhill\u2019s published Readiness Rubric v' + READ_COPILOT_RUBRIC_VERSION +
      ' (8 dimensions, 0–2 each, deterministic). ' +
      (meta.mode === "conversational"
        ? "Evidence was gathered in open conversation with Read/co-pilot and confirmed by the buyer before scoring. "
        : "Evidence was gathered through Read/co-pilot\u2019s structured interview. ") +
      'Sampled human audits calibrate the rubric behind the scenes; no human gates your report. ' +
      'Rubric derived from the Practical AI Readiness capstone objectives (Courses 4, Objectives 1–3). This is not a consulting engagement.</p>' +
      '<p class="rc-note">Report ' + esc(rid) + ' · ' + esc(meta.business_name || "") + ' · ' + esc(date) + '</p></div>' +
      '</div>';

    window.scrollTo(0, 0);
    return { result: result, verdict: v, interventionKey: interventionKey, reportId: rid, date: date };
  }

  function postSubmission(fields) {
    return fetch("/.netlify/functions/intake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ form_id: "readiness-assessment", fields: fields })
    }).then(function (r) { return r.json(); });
  }

  window.ReadCopilot = {
    startInterview: startInterview,
    startConversation: startConversation,
    probeChat: probeChat,
    wireMic: wireMic,
    renderReport: renderReport,
    scoreAssessment: scoreAssessment,
    postSubmission: postSubmission,
    DIMENSIONS: DIMENSIONS,
    QUESTIONS: QUESTIONS,
    VERDICTS: VERDICTS
  };
})();
