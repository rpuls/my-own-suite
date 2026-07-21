(function () {
  var root = document.documentElement;
  var desiredTheme = "theme-mos";
  var fallbackTheme = "theme-slate";

  function getThemeClasses() {
    return Array.from(root.classList).filter(function (name) {
      return name.indexOf("theme-") === 0;
    });
  }

  function shouldApplyMosTheme(themeClasses) {
    if (themeClasses.length === 0) {
      return true;
    }

    return themeClasses.length === 1 && themeClasses[0] === fallbackTheme;
  }

  function applyMosThemeOnce() {
    var themeClasses = getThemeClasses();

    if (!shouldApplyMosTheme(themeClasses)) {
      return;
    }

    themeClasses.forEach(function (name) {
      root.classList.remove(name);
    });

    root.classList.add(desiredTheme);
  }

  function start() {
    var observer = new MutationObserver(function () {
      applyMosThemeOnce();
    });

    applyMosThemeOnce();
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });

    window.setTimeout(function () {
      applyMosThemeOnce();
      observer.disconnect();
    }, 3000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
