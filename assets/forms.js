/* Readable suite — governed intake form submission.
   POSTs JSON {form_id, fields} to the Netlify intake function. */
(function () {
  function collect(form) {
    var fields = {};
    var data = new FormData(form);
    // Multi-value checkbox groups use names ending in []
    var seen = {};
    data.forEach(function (value, key) {
      if (key.slice(-2) === "[]") {
        var k = key.slice(0, -2);
        (fields[k] = fields[k] || []).push(value);
      } else if (seen[key]) {
        if (!Array.isArray(fields[key])) fields[key] = [fields[key]];
        fields[key].push(value);
      } else {
        seen[key] = true;
        fields[key] = value;
      }
    });
    // Single checkboxes (no [] suffix): presence means true
    form.querySelectorAll('input[type="checkbox"]:not([name$="[]"])').forEach(function (el) {
      fields[el.name] = el.checked;
    });
    return fields;
  }

  function setStatus(form, ok, msg) {
    var el = form.querySelector(".form-status");
    if (!el) return;
    el.className = "form-status " + (ok ? "ok" : "err");
    el.textContent = msg;
  }

  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!form.matches || !form.matches("form[data-form-id]")) return;
    e.preventDefault();
    var btn = form.querySelector('button[type="submit"]');
    var original = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "Submitting…"; }
    setStatus(form, true, "");

    fetch("/.netlify/functions/intake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ form_id: form.getAttribute("data-form-id"), fields: collect(form) })
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        if (res.ok && res.body && res.body.ok) {
          form.reset();
          setStatus(form, true, form.getAttribute("data-success") || "Received. A human will review your submission — this is not an enrollment or purchase.");
        } else {
          setStatus(form, false, "Something went wrong submitting the form. Please try again, or email TabronMerryhill@gmail.com.");
        }
      })
      .catch(function () {
        setStatus(form, false, "Something went wrong submitting the form. Please try again, or email TabronMerryhill@gmail.com.");
      })
      .finally(function () {
        if (btn) { btn.disabled = false; btn.textContent = original; }
      });
  });
})();

/* Readable suite — mobile navigation.
   Injects a hamburger toggle + slide-down panel (cloned from .site-nav)
   on viewports where the desktop nav is hidden. */
(function () {
  var header = document.querySelector(".site-header");
  var inner = document.querySelector(".site-header .wrap");
  var nav = document.querySelector(".site-nav");
  if (!header || !inner || !nav) return;

  var btn = document.createElement("button");
  btn.className = "nav-toggle";
  btn.type = "button";
  btn.setAttribute("aria-label", "Open menu");
  btn.setAttribute("aria-expanded", "false");
  btn.innerHTML = "<span></span><span></span><span></span>";
  inner.appendChild(btn);

  var panel = document.createElement("nav");
  panel.className = "mobile-nav";
  panel.setAttribute("aria-label", "Mobile");
  panel.innerHTML = nav.innerHTML;
  header.appendChild(panel);

  function setOpen(open) {
    document.body.classList.toggle("nav-open", open);
    btn.setAttribute("aria-expanded", String(open));
    btn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  }
  btn.addEventListener("click", function () {
    setOpen(!document.body.classList.contains("nav-open"));
  });
  panel.addEventListener("click", function (e) {
    if (e.target.closest("a")) setOpen(false);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") setOpen(false);
  });
})();
