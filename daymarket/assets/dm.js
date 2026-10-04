/* DayMarket front-end: founding-list capture + hero confetti.
   Capture posts to the intake function; on success shows a confirmation. */

(function () {
  "use strict";

  var INTAKE_URL = "https://readable.tabronmerryhill.com/.netlify/functions/intake";

  // Footer year
  document.querySelectorAll("[data-year]").forEach(function (el) {
    el.textContent = new Date().getFullYear();
  });

  // Hero confetti sprinkle (pure CSS pieces, seeded by JS)
  document.querySelectorAll(".confetti").forEach(function (box) {
    var colors = ["#ec008c", "#ffb020", "#7c5cff", "#ffffff", "#3ddc84"];
    var n = 26;
    for (var i = 0; i < n; i++) {
      var s = document.createElement("i");
      var size = 5 + Math.random() * 9;
      s.style.width = size + "px";
      s.style.height = size * (0.5 + Math.random()) + "px";
      s.style.left = Math.random() * 100 + "%";
      s.style.top = Math.random() * 100 + "%";
      s.style.background = colors[i % colors.length];
      s.style.animationDelay = (Math.random() * 6).toFixed(1) + "s";
      s.style.animationDuration = (6 + Math.random() * 7).toFixed(1) + "s";
      box.appendChild(s);
    }
  });

  // Capture forms: <form class="capture-form" data-interest="...">
  document.querySelectorAll("form.capture-form").forEach(function (form) {
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var email = form.querySelector('input[type="email"]');
      var name = form.querySelector('input[type="text"]');
      var msg = form.parentElement.querySelector(".msg") || form.querySelector(".msg");
      var btn = form.querySelector('button[type="submit"]');

      function show(cls, text) {
        if (!msg) return;
        msg.className = "msg " + cls;
        msg.textContent = text;
      }

      var emailVal = (email && email.value || "").trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailVal)) {
        show("err", "Please enter a valid email address.");
        return;
      }
      btn.disabled = true;
      var original = btn.textContent;
      btn.textContent = "Joining…";

      fetch(INTAKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          form_id: "daymarket",
          fields: {
            name: name ? name.value.trim() : "",
            email: emailVal,
            // Prefixed here so every intake backend can write Notes verbatim.
            interest: "DayMarket — " + (form.getAttribute("data-interest") || "general"),
          },
        }),
      })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (res.ok && res.j && res.j.ok) {
            form.style.display = "none";
            show("ok", "You're on the founding list. Watch your inbox — the first holidays drop soon.");
          } else {
            show("err", "Something hiccuped. Please try again in a moment.");
            btn.disabled = false;
            btn.textContent = original;
          }
        })
        .catch(function () {
          show("err", "Something hiccuped. Please try again in a moment.");
          btn.disabled = false;
          btn.textContent = original;
        });
    });
  });
})();
