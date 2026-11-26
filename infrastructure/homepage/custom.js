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

  var osDark = window.matchMedia("(prefers-color-scheme: dark)");

  function readChoice() {
    try {
      return window.localStorage.getItem("mos-theme");
    } catch (error) {
      return null;
    }
  }

  function wantsDark() {
    var choice = readChoice();
    return choice === "dark" || (choice !== "light" && osDark.matches);
  }

  // Suite Manager shares this origin; Homepage's own toggle is overruled so the two never disagree.
  function applyColorMode() {
    var dark = wantsDark();

    root.classList.toggle("dark", dark);
    root.classList.toggle("scheme-dark", dark);
    root.classList.toggle("scheme-light", !dark);

    try {
      window.localStorage.setItem("theme-mode", dark ? "dark" : "light");
    } catch (error) {
      return;
    }
  }

  function start() {
    var colorObserver = new MutationObserver(applyColorMode);

    applyColorMode();
    colorObserver.observe(root, { attributes: true, attributeFilter: ["class"] });
    osDark.addEventListener("change", applyColorMode);
    window.addEventListener("storage", applyColorMode);

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
