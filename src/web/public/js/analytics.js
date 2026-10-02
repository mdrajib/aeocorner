// PostHog on the public site, in cookieless mode (docs/UI_DESIGN.md §9): no cookies, no localStorage,
// no consent banner. Loaded only when the server renders <meta name="posthog-config"> (POSTHOG_API_KEY set).
// Requires "Cookieless server hash mode" to be switched on in the PostHog project settings.
(function () {
  const meta = document.querySelector('meta[name="posthog-config"]');
  if (!meta) return;

  // Honour Do Not Track and Global Privacy Control even though cookieless mode stores nothing.
  if (navigator.doNotTrack === '1' || navigator.globalPrivacyControl === true) return;

  let config;
  try {
    config = JSON.parse(meta.content);
  } catch {
    return;
  }

  const script = document.createElement('script');
  script.async = true;
  script.src = `${config.assetsHost}/static/array.js`;
  script.onload = () => {
    if (!window.posthog || typeof window.posthog.init !== 'function') return;
    window.posthog.init(config.apiKey, {
      api_host: config.host,
      cookieless_mode: 'always',
      person_profiles: 'never',
      disable_session_recording: true,
      autocapture: false,
      capture_pageview: true,
    });
  };
  document.head.append(script);
})();
