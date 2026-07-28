const probe = document.createElement('div')
      probe.style.cssText = 'position:absolute;top:0;left:0;width:1px;visibility:hidden;pointer-events:none'
      document.body.appendChild(probe)
      const unit = (u) => {
        probe.style.height = '100' + u
        const h = probe.getBoundingClientRect().height
        // back to nothing right away: `visibility: hidden` still takes part in
        // layout, so a measuring element left at 100lvh makes the document
        // taller than the viewport - the instrument would report the overflow
        // it just caused ("document scrollable: YES" on a page that has nothing
        // to scroll)
        probe.style.height = '0'
        return Math.round(h * 10) / 10
      }
      const inset = (side) => {
        const el = document.createElement('div')
        el.style.cssText = 'position:absolute;visibility:hidden;padding-' + side + ':env(safe-area-inset-' + side + ')'
        document.body.appendChild(el)
        const v = getComputedStyle(el)['padding' + side[0].toUpperCase() + side.slice(1)]
        el.remove()
        return v
      }
      const rows = (el, pairs) =>
        (el.innerHTML = pairs.map(([k, v, c]) => '<dt>' + k + '</dt><dd class="' + (c || '') + '">' + v + '</dd>').join(''))

      // the extremes matter more than any single reading: the toolbar only
      // moves for a moment, and a screenshot taken after it settled would show
      // nothing at all
      let minGap = Infinity, maxGap = -Infinity, minVV = Infinity, maxVV = -Infinity, n = 0

      function measure() {
        const d = document.documentElement
        const vv = window.visualViewport
        const dvh = unit('dvh'), svh = unit('svh'), lvh = unit('lvh'), vh = unit('vh')
        const seen = vv ? vv.height : innerHeight
        const gap = Math.round(seen - document.querySelector('.frame').getBoundingClientRect().bottom)
        minGap = Math.min(minGap, gap); maxGap = Math.max(maxGap, gap)
        minVV = Math.min(minVV, Math.round(seen)); maxVV = Math.max(maxVV, Math.round(seen))

        rows(document.getElementById('win'), [
          ['innerWidth', innerWidth],
          ['innerHeight', innerHeight],
          ['devicePixelRatio', devicePixelRatio],
          ['in an iframe', top === self ? 'no' : 'YES - measurement is worthless', top === self ? 'good' : 'flag'],
        ])
        rows(document.getElementById('units'), [
          ['100dvh', dvh],
          ['100svh', svh],
          ['100lvh', lvh],
          ['100vh', vh],
          ['lvh - svh (toolbar)', Math.round((lvh - svh) * 10) / 10, lvh - svh > 1 ? '' : 'flag'],
        ])
        rows(document.getElementById('vv'), [
          ['visualViewport.height', vv ? Math.round(vv.height * 10) / 10 : 'fehlt'],
          ['seen: min - max', minVV + ' - ' + maxVV, maxVV - minVV > 1 ? '' : 'flag'],
          ['visualViewport.offsetTop', vv ? Math.round(vv.offsetTop * 10) / 10 : '–'],
          ['innerHeight − vv.height', vv ? Math.round((innerHeight - vv.height) * 10) / 10 : '–'],
        ])
        rows(document.getElementById('safe'), [
          ['top', inset('top')],
          ['bottom', inset('bottom'), parseFloat(inset('bottom')) > 0 ? 'flag' : ''],
          ['left', inset('left')],
          ['right', inset('right')],
        ])
        rows(document.getElementById('doc'), [
          ['scrollHeight', d.scrollHeight],
          ['clientHeight', d.clientHeight],
          ['scrollY', Math.round(scrollY)],
          ['document scrollable', d.scrollHeight > d.clientHeight ? 'YES' : 'no', d.scrollHeight > d.clientHeight ? 'flag' : 'good'],
        ])

        const g = document.getElementById('gap')
        g.textContent = gap === 0 ? 'flush' : gap + ' px off'
        g.style.color = gap === 0 ? 'var(--ok)' : 'var(--warn)'
        document.getElementById('peak').textContent =
          'Distance from the box bottom to the visible edge, over the whole run: ' + minGap + ' to ' + maxGap + ' px.'

        const v = document.getElementById('verdict')
        if (top !== self) {
          v.innerHTML = '<b>Careful:</b> this page is inside an iframe, where every unit reports the same number and the measurement means nothing - open it directly.'
        } else if (maxGap > 1 || minGap < -1) {
          v.innerHTML = '<b>Result:</b> the 100dvh box was ' + minGap + ' to ' + maxGap + 'px off the visible area at some point.'
        } else if (maxVV - minVV <= 1) {
          v.innerHTML = '<b>No verdict yet:</b> the visible area never changed - the URL bar has not moved. Scroll harder.'
        } else {
          v.innerHTML = '<b>Result:</b> 100dvh tracked the visible area cleanly across ' + (maxVV - minVV) + 'px of toolbar movement.'
        }
        document.getElementById('tick').textContent = 'reading ' + ++n
      }

      measure()
      addEventListener('resize', measure)
      addEventListener('scroll', measure, { passive: true })
      if (window.visualViewport) {
        visualViewport.addEventListener('resize', measure)
        visualViewport.addEventListener('scroll', measure)
      }
      document.querySelector('main').addEventListener('scroll', measure, { passive: true })
      setInterval(measure, 250)
