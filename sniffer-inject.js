// Runs at document_start, before X's own scripts, so sniffer.js wraps fetch/XHR
// ahead of the first API call. content.js runs at document_idle, too late for
// the load-time Authorization bearer.

(function () {
  try {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("sniffer.js");
    script.type = "text/javascript";
    script.async = false;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  } catch (e) {
    console.error("[Affiliate Tools]", "Failed to inject sniffer:", e);
  }
})();
