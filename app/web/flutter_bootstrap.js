{{flutter_js}}
{{flutter_build_config}}

(() => {
  const fallbackBase = new URL('fonts/fallback/', document.baseURI).toString();
  const emptyFontPath = '_empty.ttf';
  const cjkMonolithicPath = 'notosanssc/v40/k3kCo84MPvpLmixcA63oeAL7Iqp5IZJF9bmaG9_FnYlNbPzS5HE.woff2';
  // Keep all 10 local Noto Color Emoji slices self-hosted and loaded on demand by Flutter's
  // FontFallbackManager rather than eagerly blocking startup (~2.2 MB saved before first frame).
  const emojiFallbackFiles = [
    'notocoloremoji/v39/Yq6P-KqIXTD0t4D9z1ESnKM3-HpFabsE4tq3luCC7p-aXxcn.0.woff2',
    'notocoloremoji/v39/Yq6P-KqIXTD0t4D9z1ESnKM3-HpFabsE4tq3luCC7p-aXxcn.1.woff2',
    'notocoloremoji/v39/Yq6P-KqIXTD0t4D9z1ESnKM3-HpFabsE4tq3luCC7p-aXxcn.2.woff2',
    'notocoloremoji/v39/Yq6P-KqIXTD0t4D9z1ESnKM3-HpFabsE4tq3luCC7p-aXxcn.3.woff2',
    'notocoloremoji/v39/Yq6P-KqIXTD0t4D9z1ESnKM3-HpFabsE4tq3luCC7p-aXxcn.4.woff2',
    'notocoloremoji/v39/Yq6P-KqIXTD0t4D9z1ESnKM3-HpFabsE4tq3luCC7p-aXxcn.5.woff2',
    'notocoloremoji/v39/Yq6P-KqIXTD0t4D9z1ESnKM3-HpFabsE4tq3luCC7p-aXxcn.6.woff2',
    'notocoloremoji/v39/Yq6P-KqIXTD0t4D9z1ESnKM3-HpFabsE4tq3luCC7p-aXxcn.7.woff2',
    'notocoloremoji/v39/Yq6P-KqIXTD0t4D9z1ESnKM3-HpFabsE4tq3luCC7p-aXxcn.8.woff2',
    'notocoloremoji/v39/Yq6P-KqIXTD0t4D9z1ESnKM3-HpFabsE4tq3luCC7p-aXxcn.9.woff2',
  ];
  const bundledFallbackFiles = new Set([
    emptyFontPath,
    cjkMonolithicPath,
    ...emojiFallbackFiles,
    'notosanssymbols/v47/rP2up3q65FkAtHfwd-eIS2brbDN6gxP34F9jRRCe4W3gfQ8gb_VFRkzrbQ.woff2',
    'notosanssymbols2/v25/I_uyMoGduATTei9eI8daxVHDyfisHr71-gTBWXPM4Q.woff2',
    'notosanssymbols2/v25/I_uyMoGduATTei9eI8daxVHDyfisHr71-jrBWXPM4Q.woff2',
    'notosanssymbols2/v25/I_uyMoGduATTei9eI8daxVHDyfisHr71-pTgfA.woff2',
    'notosanssymbols2/v25/I_uyMoGduATTei9eI8daxVHDyfisHr71-prgfE71.woff2',
    'notosanssymbols2/v25/I_uyMoGduATTei9eI8daxVHDyfisHr71-ujgfE71.woff2',
    'notosanssymbols2/v25/I_uyMoGduATTei9eI8daxVHDyfisHr71-vrgfE71.woff2',
    'notosansmath/v19/7Aump_cpkSecTWaHRlH2hyV5UHkD-V048PW0.woff2',
    'notosans/v42/o-0mIpQlx3QUlC5A4PNB6Ryti20_6n1iPHjcz6L1SoM-jCpoiyD9A99Y41P6zHtY.woff2',
    'roboto/v32/KFOmCnqEu92Fr1Me4GZLCzYlKw.woff2',
  ]);

  const origFetch = window.fetch.bind(window);
  let emptyFontBytesPromise = null;
  let cjkOwner = null;

  const removeSplash = () => {
    const splash = document.getElementById('neo-splash');
    if (!splash || splash.dataset.removing) return;
    splash.dataset.removing = '1';
    splash.classList.add('neo-splash-hide');
    setTimeout(() => splash.remove(), 180);
  };
  window.addEventListener('flutter-first-frame', removeSplash, { once: true });

  const loadEmptyFontBytes = () => {
    if (!emptyFontBytesPromise) {
      emptyFontBytesPromise = origFetch(fallbackBase + emptyFontPath)
        .then((res) => {
          if (!res.ok) throw new Error('Failed to load local empty fallback font');
          return res.arrayBuffer();
        })
        .catch((err) => {
          emptyFontBytesPromise = null;
          throw err;
        });
    }
    return emptyFontBytesPromise;
  };

  const emptyFontResponse = () =>
    loadEmptyFontBytes().then(
      (buf) =>
        new Response(buf.slice(0), {
          status: 200,
          headers: { 'Content-Type': 'font/ttf' },
        }),
    );

  window.fetch = (input, init) => {
    const rawUrl = typeof input === 'string' ? input : input && input.url ? input.url : '';
    let resolvedUrl = '';
    if (rawUrl) {
      try {
        resolvedUrl = new URL(rawUrl, document.baseURI).toString();
      } catch (_) {
        resolvedUrl = '';
      }
    }

    if (!resolvedUrl.startsWith(fallbackBase)) {
      return origFetch(input, init);
    }

    const rel = resolvedUrl.slice(fallbackBase.length).split(/[?#]/, 1)[0];
    if (bundledFallbackFiles.has(rel)) {
      return origFetch(input, init);
    }

    if (/^notosans(?:sc|tc|hk|jp)\//.test(rel)) {
      if (cjkOwner === null || cjkOwner === rel) {
        cjkOwner = rel;
        return origFetch(fallbackBase + cjkMonolithicPath)
          .then((res) => {
            if (!res.ok && cjkOwner === rel) {
              cjkOwner = null;
            }
            return res;
          })
          .catch((err) => {
            if (cjkOwner === rel) {
              cjkOwner = null;
            }
            throw err;
          });
      }
      return emptyFontResponse();
    }

    return emptyFontResponse();
  };

  // Keep every web resource on this server: never fall back to Google's CanvasKit or Fonts CDNs.
  // Passing engineConfig to initializeEngine is required when using a custom onEntrypointLoaded hook.
  const engineConfig = {
    canvasKitBaseUrl: 'canvaskit/',
    fontFallbackBaseUrl: fallbackBase,
    suppressMultithreadingWarning: true,
  };
  _flutter.loader.load({
    config: engineConfig,
    onEntrypointLoaded: async (engineInitializer) => {
      const appRunner = await engineInitializer.initializeEngine(engineConfig);
      await appRunner.runApp();
      removeSplash();
    },
  });
})();
