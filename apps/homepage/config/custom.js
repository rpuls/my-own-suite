(function () {
  var root = document.documentElement;
  var initKey = "mos-homepage-theme-defaulted";
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
    try {
      if (window.localStorage && window.localStorage.getItem(initKey) === "1") {
        return;
      }
    } catch (error) {
      // Ignore storage access failures and still try to apply the default theme.
    }

    var observer = new MutationObserver(function () {
      applyMosThemeOnce();
    });

    applyMosThemeOnce();
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });

    window.setTimeout(function () {
      applyMosThemeOnce();
      observer.disconnect();

      try {
        if (window.localStorage) {
          window.localStorage.setItem(initKey, "1");
        }
      } catch (error) {
        // Ignore storage access failures.
      }
    }, 3000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
