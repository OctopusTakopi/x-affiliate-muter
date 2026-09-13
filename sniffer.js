// Injected into the page context. Patches fetch and XMLHttpRequest to capture
// the Authorization bearer X sends, then posts it to the content script.

(function () {
  const LOG_PREFIX = "[Affiliate Tools Sniffer]";

  function safeLog(...args) {
    try {
      console.log(LOG_PREFIX, ...args);
    } catch (_) {}
  }

  if (window.__affiliateToolsSnifferInstalled) {
    return;
  }
  window.__affiliateToolsSnifferInstalled = true;

  let lastAuthorization = null;

  // Every API call X makes carries the same bearer, so posting on each one would
  // flood the page. Only a changed value gets published.
  function publish(authorization, onRequest) {
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
      return;
    }

    const isNew = authorization !== lastAuthorization;
    if (isNew) {
      lastAuthorization = authorization;
      safeLog("Captured Authorization bearer.");
    }
    if (!isNew && !onRequest) return;

    // Addressed to this page's own origin. The content script shares the window,
    // so it still gets the message.
    window.postMessage(
      {
        source: "affiliate-tools",
        type: "auth",
        authorization,
      },
      window.location.origin
    );
  }

  // This sniffer installs at document_start and the content script attaches at
  // document_idle, so the bearer is held and re-published on request.
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "affiliate-tools" || data.type !== "request-auth") {
      return;
    }
    if (lastAuthorization) publish(lastAuthorization, true);
  });

  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = async function (input, init) {
      try {
        const url =
          typeof input === "string" ? input : (input && input.url) || "";
        let isXApiCall = false;

        if (typeof url === "string" && url) {
          try {
            const u = new URL(url, window.location.origin);
            const host = (u.hostname || "").toLowerCase();
            if (host.endsWith("x.com") || host.endsWith("twitter.com")) {
              isXApiCall = true;
            }
          } catch (_) {
            if (url.includes("x.com") || url.includes("twitter.com")) {
              isXApiCall = true;
            }
          }
        }

        if (isXApiCall) {
          let authorization = null;
          let headersSource = null;

          if (init && init.headers) {
            headersSource = init.headers;
          } else if (input && typeof input === "object" && input.headers) {
            headersSource = input.headers;
          }

          if (headersSource) {
            const h = headersSource;

            if (h instanceof Headers) {
              authorization = h.get("authorization");
            } else if (Array.isArray(h)) {
              for (const [key, value] of h) {
                if (String(key).toLowerCase() === "authorization") {
                  authorization = value;
                  break;
                }
              }
            } else if (typeof h === "object") {
              for (const key in h) {
                if (Object.prototype.hasOwnProperty.call(h, key)) {
                  if (key.toLowerCase() === "authorization") {
                    authorization = h[key];
                    break;
                  }
                }
              }
            }
          }

          if (authorization) publish(authorization);
        }
      } catch (e) {
        safeLog("Error sniffing fetch:", e);
      }

      return originalFetch.apply(this, arguments);
    };
  }

  // XHR can carry the header too.
  const OriginalXHR = window.XMLHttpRequest;
  if (OriginalXHR) {
    function WrappedXHR() {
      const xhr = new OriginalXHR();
      let authHeader = null;
      let requestUrl = null;

      const originalOpen = xhr.open;
      xhr.open = function (method, url) {
        try {
          requestUrl = url;
        } catch (_) {}
        return originalOpen.apply(xhr, arguments);
      };

      const originalSetRequestHeader = xhr.setRequestHeader;
      xhr.setRequestHeader = function (name, value) {
        try {
          if (
            typeof name === "string" &&
            name.toLowerCase() === "authorization" &&
            typeof value === "string" &&
            value.startsWith("Bearer ")
          ) {
            authHeader = value;
          }
        } catch (_) {}
        return originalSetRequestHeader.apply(xhr, arguments);
      };

      const originalSend = xhr.send;
      xhr.send = function (body) {
        try {
          if (authHeader && requestUrl) {
            let isXApiCall = false;
            try {
              const u = new URL(requestUrl, window.location.origin);
              const host = (u.hostname || "").toLowerCase();
              if (host.endsWith("x.com") || host.endsWith("twitter.com")) {
                isXApiCall = true;
              }
            } catch (_) {
              if (
                String(requestUrl).includes("x.com") ||
                String(requestUrl).includes("twitter.com")
              ) {
                isXApiCall = true;
              }
            }

            if (isXApiCall) publish(authHeader);
          }
        } catch (e) {
          safeLog("Error sniffing XHR:", e);
        }
        return originalSend.apply(xhr, arguments);
      };

      return xhr;
    }

    WrappedXHR.prototype = OriginalXHR.prototype;
    window.XMLHttpRequest = WrappedXHR;
  }

  safeLog("Sniffer installed.");
})();
