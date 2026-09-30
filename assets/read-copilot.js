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
      ' (8 dimensions, 0–2 each, deterministic). Sampled human audits calibrate the rubric behind the scenes; no human gates your report. ' +
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
    renderReport: renderReport,
    scoreAssessment: scoreAssessment,
    postSubmission: postSubmission,
    DIMENSIONS: DIMENSIONS,
    QUESTIONS: QUESTIONS,
    VERDICTS: VERDICTS
  };
})();
