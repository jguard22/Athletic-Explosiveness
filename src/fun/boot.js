// Loads the Combine layer unless it is switched off. early.js (a classic script in <head>) sets data-fun on <html> only when the
// layer is on, so with ?fun=0 this file does nothing and not one kit module is fetched. A failed load falls back to the original page.
if (document.documentElement.hasAttribute("data-fun")) {
  import("./layer.js").catch((err) => {
    document.documentElement.removeAttribute("data-fun");
    console.error("[combine] the engagement layer could not load; showing the original page", err);
  });
}
