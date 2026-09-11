import type { TFunction } from 'i18next'

// countdown formats the wait until a future unix timestamp as prose: days and
// hours far out, seconds when it is nearly up. `t` is passed in rather than
// pulled from a hook so both the watches page and the download queue can use
// the same wording, and so it stays a pure function.
//
// withSec = tick down to the second (for anything happening today).
// A timestamp that has just passed returns watch.airingNow, one further back
// watch.airedAgo - callers that mean something else by "now" check the
// timestamp before asking.

// how long a slot still counts as happening rather than having happened
const AIRED_AFTER = 60 * 60 * 1000
export function countdown(t: TFunction, ts: number, withSec = false, now = Date.now()) {
  const ms = ts * 1000 - now
  // the calendar reaches a week into the past now: an hour after the slot the
  // countdown stops saying "now" and says what actually happened
  if (ms < -AIRED_AFTER) return t('watch.airedAgo')
  if (ms <= 0) return t('watch.airingNow')
  const d = Math.floor(ms / 86_400_000)
  const h = Math.floor((ms % 86_400_000) / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1_000)
  if (d > 0) return t('watch.inDaysH', { d, h })
  if (h > 0) return withSec ? t('watch.inHoursMS', { h, m, s }) : t('watch.inHoursM', { h, m })
  if (m > 0) return withSec ? t('watch.inMinutesS', { m, s }) : t('watch.inMinutes', { m })
  return withSec ? t('watch.inSeconds', { s }) : t('watch.inMinutes', { m })
}
