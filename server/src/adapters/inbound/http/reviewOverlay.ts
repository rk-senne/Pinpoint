// Review overlay asset (Mission C1).
//
// A small, dependency-free script injected into the proxied page by
// `proxy.routes.ts`. It renders a floating "Send feedback" button in a
// closed Shadow DOM (so the host page's CSS can't bleed in and vice-versa)
// and POSTs submissions to the EXISTING guest feedback endpoint
// `POST /api/v1/shared/:linkId/feedback`.
//
// It intentionally reuses the guest endpoint rather than inventing a new
// one: that endpoint already enforces the per-link Redis quota, the
// allowFeedback gate, the enumeration-oracle kill, and guest-flag marking.
//
// The script is emitted as a STRING (not bundled) so the proxy can inline it
// into the document under the wrapper CSP. All DOM is built with
// `document.createElement` + `textContent` — never `innerHTML` — so nothing
// here is a markup-injection sink.
//
// TRANSPORT (security): the proxied document runs in an OPAQUE origin (CSP
// `sandbox` without `allow-same-origin`, see proxy.routes.ts), so it must
// not — and cannot usefully — call the Pinpoint API itself. The overlay
// hands the feedback to the parent dashboard page via `postMessage`; the
// parent (ReviewLinkPage.ts) verifies the sender, validates the payload and
// performs the API call. Result is posted back the same way. No CORS surface.
//
// `reviewOverlayScript(linkId)` returns the IIFE body with the linkId safely
// embedded as a JSON literal.

/** postMessage protocol shared with dashboard/src/pages/ReviewLinkPage.ts. */
export const REVIEW_FEEDBACK_MSG = 'pinpoint:review-feedback';
export const REVIEW_FEEDBACK_RESULT_MSG = 'pinpoint:review-feedback-result';

/**
 * Build the inline overlay script for a given shared link id.
 *
 * The linkId is only used to label the dialog context; the parent page uses
 * ITS OWN linkId when calling the API, never one supplied by the frame.
 */
export function reviewOverlayScript(linkId: string): string {
  // Embed the linkId as a JSON string literal to neutralise any quoting /
  // script-breakout attempt. linkIds are 128-bit base64url tokens in
  // practice, but we never trust the shape.
  const linkIdLiteral = JSON.stringify(linkId);

  return `(function(){
  "use strict";
  var LINK_ID = ${linkIdLiteral};
  var MSG = ${JSON.stringify(REVIEW_FEEDBACK_MSG)};
  var RESULT_MSG = ${JSON.stringify(REVIEW_FEEDBACK_RESULT_MSG)};
  var pending = null;

  var host = document.createElement("div");
  host.setAttribute("data-pinpoint-review", "");
  host.style.position = "fixed";
  host.style.zIndex = "2147483647";
  host.style.bottom = "16px";
  host.style.right = "16px";
  var shadow = host.attachShadow ? host.attachShadow({ mode: "closed" }) : host;

  var style = document.createElement("style");
  style.textContent = [
    ".btn{font:14px system-ui,sans-serif;background:#4f46e5;color:#fff;border:0;border-radius:8px;padding:10px 14px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.2)}",
    ".panel{position:fixed;bottom:64px;right:16px;width:320px;max-width:90vw;background:#fff;color:#0f172a;border:1px solid #e2e8f0;border-radius:10px;padding:16px;box-shadow:0 8px 24px rgba(0,0,0,.25);font:14px system-ui,sans-serif}",
    ".panel h2{margin:0 0 8px;font-size:16px}",
    ".panel label{display:block;margin:8px 0 4px;font-size:13px}",
    ".panel textarea,.panel input,.panel select{width:100%;box-sizing:border-box;padding:8px;border:1px solid #cbd5e1;border-radius:6px;font:inherit}",
    ".row{display:flex;gap:8px;margin-top:12px}",
    ".row button{flex:1;padding:8px;border-radius:6px;border:0;cursor:pointer;font:inherit}",
    ".ok{background:#4f46e5;color:#fff}",
    ".cancel{background:#f1f5f9;color:#0f172a}",
    ".msg{margin-top:8px;font-size:13px}",
    "[hidden]{display:none}"
  ].join("");
  shadow.appendChild(style);

  var btn = document.createElement("button");
  btn.className = "btn";
  btn.type = "button";
  btn.textContent = "Send feedback";
  shadow.appendChild(btn);

  var panel = null;

  function close(){ if(panel){ panel.remove(); panel = null; } }

  function open(){
    if(panel) return;
    panel = document.createElement("div");
    panel.className = "panel";
    panel.setAttribute("role","dialog");
    panel.setAttribute("aria-label","Send feedback");

    var h = document.createElement("h2");
    h.textContent = "Send feedback";
    panel.appendChild(h);

    var nameLabel = document.createElement("label");
    nameLabel.textContent = "Your name";
    var name = document.createElement("input");
    name.type = "text";
    name.maxLength = 100;
    panel.appendChild(nameLabel); panel.appendChild(name);

    var descLabel = document.createElement("label");
    descLabel.textContent = "Feedback";
    var desc = document.createElement("textarea");
    desc.rows = 4; desc.maxLength = 5000;
    panel.appendChild(descLabel); panel.appendChild(desc);

    var sevLabel = document.createElement("label");
    sevLabel.textContent = "Severity";
    var sev = document.createElement("select");
    [["informational","Informational"],["minor","Minor"],["major","Major"],["critical","Critical"]].forEach(function(o){
      var opt = document.createElement("option"); opt.value = o[0]; opt.textContent = o[1]; sev.appendChild(opt);
    });
    panel.appendChild(sevLabel); panel.appendChild(sev);

    var msg = document.createElement("div");
    msg.className = "msg"; msg.hidden = true;
    panel.appendChild(msg);

    var row = document.createElement("div");
    row.className = "row";
    var cancel = document.createElement("button");
    cancel.type = "button"; cancel.className = "cancel"; cancel.textContent = "Cancel";
    var submit = document.createElement("button");
    submit.type = "button"; submit.className = "ok"; submit.textContent = "Submit";
    row.appendChild(cancel); row.appendChild(submit);
    panel.appendChild(row);

    shadow.appendChild(panel);
    desc.focus();

    cancel.addEventListener("click", close);
    submit.addEventListener("click", function(){
      var nameVal = (name.value || "").trim();
      var descVal = (desc.value || "").trim();
      if(!nameVal || !descVal){
        msg.hidden = false; msg.style.color = "#dc2626";
        msg.textContent = "Name and feedback are required.";
        return;
      }
      submit.disabled = true; submit.textContent = "Submitting…";
      function finish(ok){
        if(pending){ clearTimeout(pending.timer); window.removeEventListener("message", pending.onMsg); pending = null; }
        msg.hidden = false;
        if(ok){
          msg.style.color = "#16a34a";
          msg.textContent = "Thanks! Your feedback was submitted.";
          desc.value = "";
          setTimeout(close, 1500);
        } else {
          msg.style.color = "#dc2626";
          msg.textContent = "Submission failed. Please try again.";
        }
        submit.disabled = false; submit.textContent = "Submit";
      }
      if(window.parent === window){
        // Opened directly rather than inside the dashboard review page.
        msg.hidden = false; msg.style.color = "#dc2626";
        msg.textContent = "Open this review link from the Pinpoint dashboard to send feedback.";
        submit.disabled = false; submit.textContent = "Submit";
        return;
      }
      var id = String(Date.now()) + "-" + Math.random().toString(36).slice(2);
      var onMsg = function(ev){
        var d = ev.data;
        if(ev.source !== window.parent || !d || d.type !== RESULT_MSG || d.id !== id) return;
        finish(d.ok === true);
      };
      pending = { onMsg: onMsg, timer: setTimeout(function(){ finish(false); }, 20000) };
      window.addEventListener("message", onMsg);
      // targetOrigin "*" is required (the dashboard origin is unknown to the
      // opaque frame); the parent is pinned by frame-ancestors and the payload
      // is only the user's own typed feedback.
      window.parent.postMessage({
        type: MSG, id: id,
        payload: { name: nameVal, description: descVal, severity: sev.value, pageUrl: location.href }
      }, "*");
    });
  }

  btn.addEventListener("click", function(){ if(panel){ close(); } else { open(); } });
  (document.body || document.documentElement).appendChild(host);
})();`;
}
