// Strings and retry of offline.html. External because the server's CSP allows
// no inline scripts. The app's own language choice (localStorage) wins over the
// browser's.
;(function () {
  var texts = {
    en: {
      title: 'Server unreachable',
      text: 'WeebSync cannot reach your server right now. Check your connection or the server, then try again.',
      retry: 'Try again',
    },
    de: {
      title: 'Server nicht erreichbar',
      text: 'WeebSync erreicht deinen Server gerade nicht. Prüfe die Verbindung oder den Server und versuche es dann erneut.',
      retry: 'Erneut versuchen',
    },
  }
  var lang = ''
  try {
    lang = localStorage.getItem('weebsync.locale') || ''
  } catch (e) {
    /* storage blocked */
  }
  var l = (lang || navigator.language || 'en').slice(0, 2) === 'de' ? 'de' : 'en'
  document.documentElement.lang = l
  document.getElementById('title').textContent = texts[l].title
  document.getElementById('text').textContent = texts[l].text
  document.getElementById('retry').textContent = texts[l].retry
  // this page answers under the address that failed, so a reload retries it
  document.getElementById('retry').addEventListener('click', function () {
    location.reload()
  })
})()
